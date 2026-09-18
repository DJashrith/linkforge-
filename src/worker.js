// Click worker: `npm run worker`. Runs separately from the web server.
// Several of these can run at once, the consumer group splits the events between them.
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool } from './db.js';
import { createRedis } from './redis.js';
import { ensureGroup, processOnce, claimAbandoned } from './clicks/consumer.js';

const CONSUMER = `${hostname()}-${process.pid}`;
const BLOCK_MS = 2000;
const CLAIM_EVERY_MS = 30_000;

// Its own connection with no command timeout, since XREADGROUP BLOCK holds it open.
const redis = createRedis();

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('finishing current batch, then stopping');
    stopping = true;
  });
}

await redis.connect();
await pool.query('SELECT 1');
await ensureGroup(redis);
console.log(`click worker ${CONSUMER} started`);

let lastClaim = 0;
let failures = 0;

while (!stopping) {
  try {
    if (Date.now() - lastClaim > CLAIM_EVERY_MS) {
      const claimed = await claimAbandoned(redis, CONSUMER);
      if (claimed) console.log(`claimed ${claimed} abandoned event(s)`);
      lastClaim = Date.now();
    }
    const handled = await processOnce(redis, { consumer: CONSUMER, blockMs: BLOCK_MS });
    if (handled) console.log(`saved ${handled} click event(s)`);
    failures = 0;
  } catch (err) {
    // Redis restarted without persistence: the stream and group are gone, recreate them.
    if (err.message?.includes('NOGROUP')) {
      await ensureGroup(redis).catch(() => {});
      continue;
    }
    failures++;
    const wait = Math.min(10_000, 500 * 2 ** failures);
    console.error(`batch failed (${err.message}), retrying in ${wait}ms`);
    await sleep(wait);
  }
}

await redis.quit();
await pool.end();
