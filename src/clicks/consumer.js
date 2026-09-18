// Consumer side of click tracking: read a batch from the stream, write it to
// Postgres, then ack. If the process dies before the ack, the entries stay
// pending in Redis and get picked up again, so nothing is lost. Replays are
// harmless because event_id is UNIQUE.
import { pool } from '../db.js';
import { STREAM, GROUP } from './queue.js';
import { toClickRow } from './events.js';

const BATCH_SIZE = 500;
// Entries a consumer has held this long without acking are assumed abandoned
// (that worker crashed) and get claimed by whoever notices.
const ABANDONED_AFTER_MS = 60_000;

export async function ensureGroup(redis) {
  try {
    // "0" so events queued before the group existed are still processed
    await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) throw err;
  }
}

/**
 * Handles one batch. Throws if Postgres is unavailable, leaving the batch
 * pending so the next call retries it.
 * @returns {Promise<number>} entries handled (0 = nothing to do)
 */
export async function processOnce(redis, { consumer, blockMs = 0 }) {
  // Our own unacked entries first (a previous attempt failed), then new ones.
  let entries = await read(redis, consumer, '0');
  if (entries.length === 0) entries = await read(redis, consumer, '>', blockMs);
  if (entries.length === 0) return 0;

  const rows = [];
  for (const [id, fields] of entries) {
    const row = toClickRow(fields);
    if (row) rows.push(row);
    else console.warn(`skipping malformed click event ${id}`);
  }
  if (rows.length > 0) await saveClicks(rows);

  const ids = entries.map(([id]) => id);
  await redis.multi().xack(STREAM, GROUP, ...ids).xdel(STREAM, ...ids).exec();
  return entries.length;
}

/** Moves entries stuck with a dead consumer over to this one. */
export async function claimAbandoned(redis, consumer, { minIdleMs = ABANDONED_AFTER_MS } = {}) {
  const [, claimed] = await redis.xautoclaim(STREAM, GROUP, consumer, minIdleMs, '0-0', 'COUNT', BATCH_SIZE);
  return claimed.length;
}

/**
 * Inserts the events and bumps click_count in one statement, so the two can't
 * drift apart. The count only goes up for rows that were actually inserted, so
 * replaying a batch doesn't double count.
 * Events for links deleted in the meantime are dropped by the JOIN.
 */
export async function saveClicks(rows) {
  const { rowCount } = await pool.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
         event_id uuid, code text, clicked_at timestamptz, referrer text,
         user_agent text, country text, region text, city text)
     ),
     inserted AS (
       INSERT INTO click_events (event_id, url_id, clicked_at, referrer, user_agent, country, region, city)
       SELECT i.event_id, u.id, i.clicked_at, i.referrer, i.user_agent, i.country, i.region, i.city
       FROM input i JOIN urls u ON u.short_code = i.code
       ON CONFLICT (event_id) DO NOTHING
       RETURNING url_id
     )
     UPDATE urls SET click_count = urls.click_count + c.n
     FROM (SELECT url_id, count(*) AS n FROM inserted GROUP BY url_id) c
     WHERE urls.id = c.url_id`,
    [JSON.stringify(rows)],
  );
  return rowCount; // links updated, not events
}

async function read(redis, consumer, id, blockMs = 0) {
  const args = ['GROUP', GROUP, consumer, 'COUNT', BATCH_SIZE];
  // BLOCK 0 would mean "wait forever", so only block when asked to
  if (blockMs > 0 && id === '>') args.push('BLOCK', blockMs);
  const result = await redis.xreadgroup(...args, 'STREAMS', STREAM, id);
  return result?.[0]?.[1] ?? [];
}
