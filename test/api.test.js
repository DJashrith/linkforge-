// End-to-end tests for shortening and redirecting (see helpers.js for setup).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from '../src/base62.js';
import { skip, startTestApp } from './helpers.js';

let t, pool;
const shorten = (body) => t.shorten(body);
const visit = (code) => t.visit(code);

before(async () => {
  if (skip) return;
  t = await startTestApp();
  pool = t.pool;
});
after(() => t?.close());
beforeEach(() => t?.reset());

test('shorten then redirect with a 302', { skip }, async () => {
  const { status, body } = await shorten({ url: 'https://example.com/hello' });
  assert.equal(status, 201);
  assert.equal(body.short_code, '1');

  for (let i = 0; i < 3; i++) {
    const res = await visit(body.short_code);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/hello');
  }
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
  const expire = await t.admin('PATCH', `/urls/${first.body.short_code}`, { expires_at: '2020-01-01T00:00:00Z' });
  assert.equal(expire.status, 200);

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
