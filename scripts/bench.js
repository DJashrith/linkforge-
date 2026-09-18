// Redirect benchmark: `npm run bench -- http://localhost:3000 "label"`
//
// 1. Creates LINKS short links through the API (so it works against any version).
// 2. Latency: SEQUENTIAL_REQUESTS redirects one at a time over a keep-alive
//    connection, timed with hrtime so sub-millisecond differences show up.
// 3. Throughput: autocannon with CONNECTIONS concurrent connections for DURATION seconds.
// Every request picks a random link, and redirects are not followed.
import http from 'node:http';
import autocannon from 'autocannon';

const target = process.argv[2] ?? 'http://localhost:3000';
const label = process.argv[3] ?? target;

const LINKS = 1000;
const SEQUENTIAL_REQUESTS = 5000;
const CONNECTIONS = 50;
const DURATION = 15;

const codes = await seed();
const randomPath = () => `/${codes[Math.floor(Math.random() * codes.length)]}`;

// Warm-up: JIT, connection pools and (when enabled) the cache.
await sequential(2000);
const latency = await sequential(SEQUENTIAL_REQUESTS);
const pgBefore = await postgresTransactions();
const load = await autocannon({
  url: target,
  connections: CONNECTIONS,
  duration: DURATION,
  requests: [{ setupRequest: (req) => ({ ...req, path: randomPath() }) }],
});
const pgAfter = await postgresTransactions();

const responses = Object.values(load.statusCodeStats).reduce((n, s) => n + s.count, 0);
const redirects = load.statusCodeStats['302']?.count ?? 0;
const failures = load.errors + load.timeouts + (responses - redirects);

console.log(`\n${label}`);
console.log(`  one at a time (${SEQUENTIAL_REQUESTS} req): p50 ${ms(latency.p50)}  p99 ${ms(latency.p99)}  mean ${ms(latency.mean)}`);
console.log(`  ${CONNECTIONS} connections (${DURATION}s):   ${Math.round(load.requests.average)} req/s  p50 ${load.latency.p50}ms  p99 ${load.latency.p99}ms`);
if (pgBefore !== null) {
  console.log(`  postgres during the load test: ~${Math.round((pgAfter - pgBefore) / DURATION)} queries/s`);
}
if (failures > 0) console.log(`  !! ${failures} requests did not return a 302`);

// Committed transactions on the app's database (each query outside a transaction
// counts as one). Postgres flushes these stats lazily, so it's approximate.
// Only available when DATABASE_URL is set for the bench too.
async function postgresTransactions() {
  if (!process.env.DATABASE_URL) return null;
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    'SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()',
  );
  await client.end();
  return Number(rows[0].xact_commit);
}

async function seed() {
  const out = [];
  for (let i = 0; i < LINKS; i += 50) {
    const batch = Array.from({ length: Math.min(50, LINKS - i) }, (_, j) =>
      fetch(`${target}/shorten`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `https://example.com/bench/${i + j}` }),
      }).then((r) => r.json()),
    );
    for (const body of await Promise.all(batch)) {
      if (!body.short_code) throw new Error(`seeding failed: ${JSON.stringify(body)}`);
      out.push(body.short_code);
    }
  }
  return out;
}

async function sequential(n) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const times = [];
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    const status = await get(randomPath(), agent);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
    if (status !== 302) throw new Error(`expected 302, got ${status}`);
  }
  agent.destroy();
  times.sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
  return { p50: pct(50), p99: pct(99), mean: times.reduce((a, b) => a + b, 0) / times.length };
}

function get(path, agent) {
  return new Promise((resolve, reject) => {
    http
      .get(target + path, { agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });
}

function ms(value) {
  return `${value.toFixed(2)}ms`;
}
