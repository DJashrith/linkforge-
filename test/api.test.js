// End-to-end tests against a real Postgres. They WIPE the urls table, so they only
// run when TEST_DATABASE_URL is set; point it at a throwaway database.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { decode, encode } from '../src/base62.js';

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : 'set TEST_DATABASE_URL to run API tests';

let server, baseUrl, pool;

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = TEST_DB;

  const migrate = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'migrate.js')], {
    env: process.env,
    encoding: 'utf8',
  });
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stderr}`);

  ({ pool } = await import('../src/db.js'));
  const { app } = await import('../src/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (skip) return;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  if (skip) return;
  await pool.query('TRUNCATE urls RESTART IDENTITY');
});

function shorten(body) {
  return fetch(`${baseUrl}/shorten`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

function visit(code) {
  return fetch(`${baseUrl}/${code}`, { redirect: 'manual' });
}

test('shorten then redirect with a 302, counting clicks', { skip }, async () => {
  const { status, body } = await shorten({ url: 'https://example.com/hello' });
  assert.equal(status, 201);
  assert.equal(body.short_code, '1');

  for (let i = 0; i < 3; i++) {
    const res = await visit(body.short_code);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/hello');
  }
  const { rows } = await pool.query('SELECT click_count FROM urls WHERE short_code = $1', ['1']);
  assert.equal(rows[0].click_count, '3');
});

test('submitting the same URL twice returns the same short link', { skip }, async () => {
  const first = await shorten({ url: 'https://example.com/dup' });
  const second = await shorten({ url: 'https://EXAMPLE.com:443/dup' }); // same URL once normalized
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.short_code, first.body.short_code);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM urls');
  assert.equal(rows[0].n, 1);
});

test('an expired link is not reused and returns 410', { skip }, async () => {
  const first = await shorten({ url: 'https://example.com/old' });
  await pool.query(`UPDATE urls SET expires_at = now() - interval '1 minute'`);

  assert.equal((await visit(first.body.short_code)).status, 410);

  const again = await shorten({ url: 'https://example.com/old' });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.short_code, first.body.short_code);
});

test('unknown and malformed codes return 404', { skip }, async () => {
  assert.equal((await visit('nope')).status, 404);
  assert.equal((await visit('favicon.ico')).status, 404);
});

test('custom alias: create, redirect, conflict, retry', { skip }, async () => {
  const created = await shorten({ url: 'https://example.com/launch', alias: 'launch' });
  assert.equal(created.status, 201);
  assert.equal(created.body.short_code, 'launch');
  assert.equal((await visit('launch')).headers.get('location'), 'https://example.com/launch');

  const retry = await shorten({ url: 'https://example.com/launch', alias: 'launch' });
  assert.equal(retry.status, 200);

  const taken = await shorten({ url: 'https://example.com/other', alias: 'launch' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already taken/);
});

test('invalid and reserved aliases are rejected', { skip }, async () => {
  assert.equal((await shorten({ url: 'https://example.com', alias: 'x' })).status, 400);
  assert.equal((await shorten({ url: 'https://example.com', alias: 'shorten' })).status, 400);
  assert.equal((await shorten({ url: 'https://example.com', alias: 'a b' })).status, 400);
});

test('generated codes skip over ids whose code is already taken by an alias', { skip }, async () => {
  // Someone grabs "abc" as an alias; later the id sequence reaches decode("abc").
  await shorten({ url: 'https://example.com/alias', alias: 'abc' });
  const target = decode('abc');
  await pool.query(`SELECT setval(pg_get_serial_sequence('urls', 'id'), $1)`, [String(target - 1n)]);

  const { status, body } = await shorten({ url: 'https://example.com/generated' });
  assert.equal(status, 201);
  assert.equal(body.short_code, encode(target + 1n)); // "abd"
  assert.equal((await visit('abc')).headers.get('location'), 'https://example.com/alias');
});

test('an alias that matches an existing generated code gets a 409', { skip }, async () => {
  // push ids into 3-character territory so the code is a valid alias length
  await pool.query(`SELECT setval(pg_get_serial_sequence('urls', 'id'), 5000)`);
  const generated = await shorten({ url: 'https://example.com/generated' });
  assert.equal(generated.body.short_code, encode(5001n));

  const clash = await shorten({ url: 'https://example.com/other', alias: generated.body.short_code });
  assert.equal(clash.status, 409);
});

test('malicious or bogus URLs are rejected with 400', { skip }, async () => {
  for (const url of [
    'javascript:alert(1)',
    'http://169.254.169.254/latest/meta-data',
    'https://paypal.com@evil.example',
    'http://localhost:3000/1',
    'not a url',
  ]) {
    const res = await shorten({ url });
    assert.equal(res.status, 400, url);
  }
});
