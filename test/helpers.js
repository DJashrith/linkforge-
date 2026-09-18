// Shared setup for tests that need the real app, Postgres and Redis.
// They WIPE the urls/click_events tables and FLUSH the Redis database, so they only
// run when TEST_DATABASE_URL and TEST_REDIS_URL are set. Point both at throwaway ones.
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

export const skip = TEST_DB && TEST_REDIS ? false : 'set TEST_DATABASE_URL and TEST_REDIS_URL to run';
export const ADMIN_TOKEN = 'test-admin-token';

export async function startTestApp() {
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB,
    REDIS_URL: TEST_REDIS,
    ADMIN_TOKEN,
    TRUST_PROXY: 'loopback', // lets tests fake the visitor IP with X-Forwarded-For
  });

  const migrate = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'migrate.js')], {
    env: process.env,
    encoding: 'utf8',
  });
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stderr}`);

  // Imported only now, because config is read from process.env at import time.
  const { pool } = await import('../src/db.js');
  const { redis, createRedis } = await import('../src/redis.js');
  const { app } = await import('../src/app.js');
  await redis.connect();

  const server = app.listen(0);
  await once(server, 'listening');
  const baseUrl = `http://localhost:${server.address().port}`;

  return {
    pool,
    redis,
    createRedis,
    baseUrl,

    async reset() {
      await pool.query('TRUNCATE urls, click_events RESTART IDENTITY');
      await redis.flushdb();
    },

    async close() {
      await new Promise((resolve) => server.close(resolve));
      await Promise.all([pool.end(), redis.quit()]);
    },

    shorten(body) {
      return request(baseUrl, 'POST', '/shorten', body);
    },

    admin(method, path, body) {
      return request(baseUrl, method, path, body, { authorization: `Bearer ${ADMIN_TOKEN}` });
    },

    visit(code, headers = {}) {
      return fetch(`${baseUrl}/${code}`, { redirect: 'manual', headers });
    },
  };
}

async function request(baseUrl, method, path, body, headers = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Polls until check() is truthy; for fire-and-forget work like cache fills and click events. */
export async function waitFor(check, { timeoutMs = 2000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
