// Async click tracking: redirect -> Redis Stream -> consumer -> Postgres.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { skip, startTestApp, waitFor } from './helpers.js';

let t, worker, consumer, STREAM, GROUP;

before(async () => {
  if (skip) return;
  t = await startTestApp();
  consumer = await import('../src/clicks/consumer.js');
  ({ STREAM, GROUP } = await import('../src/clicks/queue.js'));
  worker = t.createRedis(); // separate connection, like the real worker
  await worker.connect();
});
after(async () => {
  await worker?.quit();
  await t?.close();
});
beforeEach(async () => {
  if (skip) return;
  await t.reset();
  await consumer.ensureGroup(worker);
});

const streamLength = () => t.redis.xlen(STREAM);
const waitForEvents = (n) => waitFor(async () => (await streamLength()) >= n, { what: `${n} click event(s)` });
const processAll = () => consumer.processOnce(worker, { consumer: 'test-worker' });

async function clickCount(code) {
  const { rows } = await t.pool.query('SELECT click_count FROM urls WHERE short_code = $1', [code]);
  return Number(rows[0].click_count);
}

test('a redirect queues an event and the worker stores it with referrer, UA and location', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/track' });

  const res = await t.visit(body.short_code, {
    referer: 'https://news.ycombinator.com/item?id=1',
    'user-agent': 'Mozilla/5.0 (test)',
    'x-forwarded-for': '81.2.69.160', // a UK address in the GeoLite data
  });
  assert.equal(res.status, 302);

  // The redirect doesn't write to Postgres, so nothing is counted yet
  await waitForEvents(1);
  assert.equal(await clickCount(body.short_code), 0);

  assert.equal(await processAll(), 1);

  const { rows: [click] } = await t.pool.query('SELECT * FROM click_events');
  assert.equal(click.referrer, 'https://news.ycombinator.com/item?id=1');
  assert.equal(click.user_agent, 'Mozilla/5.0 (test)');
  assert.equal(click.country, 'GB');
  assert.equal(click.region, 'ENG');
  assert.ok(click.city);
  assert.ok(Date.now() - click.clicked_at.getTime() < 10_000);
  assert.equal(await clickCount(body.short_code), 1);

  // processed events are acked and deleted from the stream
  assert.equal(await streamLength(), 0);
  assert.equal(await processAll(), 0);
});

test('events are batched, and the count matches the number of redirects', { skip }, async () => {
  const a = (await t.shorten({ url: 'https://example.com/a' })).body.short_code;
  const b = (await t.shorten({ url: 'https://example.com/b' })).body.short_code;

  await Promise.all([
    ...Array.from({ length: 30 }, () => t.visit(a)),
    ...Array.from({ length: 12 }, () => t.visit(b)),
  ]);
  await waitForEvents(42);

  assert.equal(await processAll(), 42);
  assert.equal(await clickCount(a), 30);
  assert.equal(await clickCount(b), 12);
});

test('HEAD requests redirect but are not counted', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/head' });
  const res = await fetch(`${t.baseUrl}/${body.short_code}`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(await streamLength(), 0);
});

test('replaying the same events does not double count', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/replay' });
  const row = {
    event_id: '3f0c6c1e-3a52-4c55-9b53-0d7c6a1e2b10',
    code: body.short_code,
    clicked_at: new Date().toISOString(),
    referrer: null, user_agent: null, country: null, region: null, city: null,
  };

  await consumer.saveClicks([row]);
  await consumer.saveClicks([row]); // e.g. worker crashed after the INSERT but before the XACK

  assert.equal(await clickCount(body.short_code), 1);
  const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM click_events');
  assert.equal(rows[0].n, 1);
});

test('events a crashed worker was holding get claimed and processed by another', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/crash' });
  await t.visit(body.short_code);
  await t.visit(body.short_code);
  await waitForEvents(2);

  // "dead-worker" reads the events and dies before acking them
  await worker.xreadgroup('GROUP', GROUP, 'dead-worker', 'COUNT', 10, 'STREAMS', STREAM, '>');
  assert.equal(await processAll(), 0, 'new reads should not see them, they belong to dead-worker');

  assert.equal(await consumer.claimAbandoned(worker, 'test-worker', { minIdleMs: 0 }), 2);
  assert.equal(await processAll(), 2);
  assert.equal(await clickCount(body.short_code), 2);
});

test('malformed events are skipped instead of blocking the queue', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/ok' });
  await t.redis.xadd(STREAM, '*', 'id', 'not-a-uuid', 'code', body.short_code, 'ts', 'yesterday');
  await t.visit(body.short_code);
  await waitForEvents(2);

  assert.equal(await processAll(), 2);
  assert.equal(await clickCount(body.short_code), 1);
  assert.equal(await streamLength(), 0);
});

test('events for a link deleted before processing are dropped', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/gone' });
  await t.visit(body.short_code);
  await waitForEvents(1);
  await t.admin('DELETE', `/urls/${body.short_code}`);

  assert.equal(await processAll(), 1);
  const { rows } = await t.pool.query('SELECT count(*)::int AS n FROM click_events');
  assert.equal(rows[0].n, 0);
});

test('stats endpoint summarises clicks', { skip }, async () => {
  const { body } = await t.shorten({ url: 'https://example.com/stats' });
  const code = body.short_code;
  const visits = [
    { 'x-forwarded-for': '81.2.69.160', referer: 'https://twitter.com/x' },
    { 'x-forwarded-for': '81.2.69.160', referer: 'https://twitter.com/y' },
    { 'x-forwarded-for': '8.8.8.8', referer: 'https://www.google.com/' },
    { 'x-forwarded-for': '127.0.0.1' }, // no referrer, no location
  ];
  for (const headers of visits) await t.visit(code, headers);
  await waitForEvents(visits.length);
  await processAll();

  const { status, body: stats } = await t.admin('GET', `/urls/${code}/stats`);
  assert.equal(status, 200);
  assert.equal(stats.total_clicks, 4);
  assert.equal(stats.clicks_by_day.length, 1);
  assert.equal(stats.clicks_by_day[0].clicks, 4);
  assert.deepEqual(stats.top_countries, [
    { country: 'GB', clicks: 2 },
    { country: '??', clicks: 1 },
    { country: 'US', clicks: 1 },
  ]);
  assert.deepEqual(stats.top_referrers, [
    { referrer: 'twitter.com', clicks: 2 },
    { referrer: 'direct', clicks: 1 },
    { referrer: 'www.google.com', clicks: 1 },
  ]);
});
