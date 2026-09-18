// Redis cache + invalidation, and the admin endpoints that trigger invalidation.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { skip, startTestApp, waitFor } from './helpers.js';

let t, cache;

before(async () => {
  if (skip) return;
  t = await startTestApp();
  cache = await import('../src/cache.js');
});
after(() => t?.close());
beforeEach(() => t?.reset());

const cached = (code) => t.redis.get(`link:${code}`);
const location = async (code) => (await t.visit(code)).headers.get('location');

test('redirects are served from the cache once it is warm', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/a' });
  await t.redis.del(`link:${body.short_code}`); // start cold

  assert.equal(await location(body.short_code), 'https://example.com/a');
  await waitFor(async () => (await cached(body.short_code)) === 'https://example.com/a', { what: 'cache fill' });

  // Change Postgres behind the app's back: the cached value still wins,
  // which proves the redirect didn't touch Postgres.
  await t.pool.query(`UPDATE urls SET long_url = 'https://example.com/changed'`);
  assert.equal(await location(body.short_code), 'https://example.com/a');
});

test('creating a link writes it to the cache straight away', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/new' });
  assert.equal(await cached(body.short_code), 'https://example.com/new');
  const ttl = await t.redis.ttl(`link:${body.short_code}`);
  assert.ok(ttl > 0 && ttl <= 3600, `ttl was ${ttl}`);
});

test('updating the URL invalidates the cache immediately', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/before' });
  assert.equal(await location(body.short_code), 'https://example.com/before');

  const res = await t.admin('PATCH', `/urls/${body.short_code}`, { url: 'https://example.com/after' });
  assert.equal(res.status, 200);
  assert.equal(res.body.long_url, 'https://example.com/after');
  assert.equal(await location(body.short_code), 'https://example.com/after');
});

test('deleting a link invalidates the cache immediately', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/doomed' });
  assert.equal((await t.visit(body.short_code)).status, 302);

  assert.equal((await t.admin('DELETE', `/urls/${body.short_code}`)).status, 204);
  assert.equal((await t.visit(body.short_code)).status, 404);
  assert.equal(await cached(body.short_code), cache.MISSING);
  assert.equal((await t.admin('DELETE', `/urls/${body.short_code}`)).status, 404);
});

test('unknown codes are cached as missing, and creating that alias overrides it', { skip }, async () => {
  assert.equal((await t.visit('soon')).status, 404);
  await waitFor(async () => (await cached('soon')) === cache.MISSING, { what: 'negative cache fill' });
  assert.ok((await t.redis.ttl('link:soon')) <= 60);

  await t.shorten({ url: 'https://example.com/soon', alias: 'soon' });
  assert.equal(await location('soon'), 'https://example.com/soon');
});

test('a slow cache fill cannot put a stale value back after an update', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/v1' });
  const staleRow = { long_url: 'https://example.com/v1', expires_at: null };

  await t.admin('PATCH', `/urls/${body.short_code}`, { url: 'https://example.com/v2' });
  // A reader that fetched v1 from Postgres before the update, finishing late:
  await cache.fill(body.short_code, cache.entryFor(staleRow));

  assert.equal(await location(body.short_code), 'https://example.com/v2');
});

test('expiry: cache TTL never outlives the link, and expiring/unexpiring takes effect at once', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/temp' });
  const code = body.short_code;

  const soon = new Date(Date.now() + 30_000).toISOString();
  await t.admin('PATCH', `/urls/${code}`, { expires_at: soon });
  const ttl = await t.redis.ttl(`link:${code}`);
  assert.ok(ttl > 0 && ttl <= 30, `ttl was ${ttl}`);

  await t.admin('PATCH', `/urls/${code}`, { expires_at: '2020-01-01T00:00:00Z' });
  assert.equal((await t.visit(code)).status, 410);

  await t.admin('PATCH', `/urls/${code}`, { expires_at: null });
  assert.equal((await t.visit(code)).status, 302);
});

test('a write-through that fails while Redis is unreachable gets cleaned up afterwards', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/old' });
  const code = body.short_code;
  const admin = t.createRedis();
  await admin.connect();

  // Redis stops accepting writes (reads still work), so the app's SET times out.
  await admin.client('PAUSE', 5000, 'WRITE');
  try {
    const res = await t.admin('PATCH', `/urls/${code}`, { url: 'https://example.com/new' });
    assert.equal(res.status, 200, 'Postgres is the source of truth, the update still succeeds');
    // (checked on the other connection: the app's one is stuck behind its paused SET)
    assert.equal(await admin.get(`link:${code}`), 'https://example.com/old', 'cache is stale while Redis is out');
  } finally {
    await admin.client('UNPAUSE');
    await admin.quit();
  }

  await cache.flushInvalidations(); // what the 5s retry timer does
  assert.equal(await location(code), 'https://example.com/new');
});

test('entryFor picks the right value and TTL', { skip }, () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.deepEqual(cache.entryFor(null, now), { value: cache.MISSING, ttl: 60 });
  assert.deepEqual(cache.entryFor({ long_url: 'https://a.example/', expires_at: null }, now),
    { value: 'https://a.example/', ttl: 3600 });
  assert.deepEqual(cache.entryFor({ long_url: 'https://a.example/', expires_at: '2026-01-01T00:00:10Z' }, now),
    { value: 'https://a.example/', ttl: 10 });
  assert.equal(cache.entryFor({ long_url: 'https://a.example/', expires_at: '2025-12-31T00:00:00Z' }, now).value,
    cache.EXPIRED);
});

test('admin endpoints need the token', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/x' });
  const path = `/urls/${body.short_code}`;

  assert.equal((await fetch(t.baseUrl + path)).status, 401);
  assert.equal((await fetch(t.baseUrl + path, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(t.baseUrl + path, { method: 'DELETE' })).status, 401);

  const details = await t.admin('GET', path);
  assert.equal(details.status, 200);
  assert.equal(details.body.click_count, 0);
  assert.equal(details.body.is_custom, false);
});

test('PATCH validates its input', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/x' });
  const path = `/urls/${body.short_code}`;

  assert.equal((await t.admin('PATCH', path, {})).status, 400);
  assert.equal((await t.admin('PATCH', path, { url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await t.admin('PATCH', path, { expires_at: 'tomorrow' })).status, 400);
  assert.equal((await t.admin('PATCH', path, { expires_at: 3 })).status, 400);
  assert.equal((await t.admin('PATCH', '/urls/nope', { url: 'https://example.com' })).status, 404);
});
