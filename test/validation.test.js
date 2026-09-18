import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLongUrl, validateAlias, validateExpiresAt, SHORT_CODE_PATTERN } from '../src/validation.js';

const ok = (input, opts) => validateLongUrl(input, opts).url;
const err = (input, opts) => validateLongUrl(input, opts).error;

test('accepts normal http(s) URLs and normalizes them', () => {
  assert.equal(ok('https://example.com'), 'https://example.com/');
  assert.equal(ok('  HTTP://Example.COM:80/a b  '), 'http://example.com/a%20b');
  assert.equal(ok('https://sub.example.co.uk/path?q=1#top'), 'https://sub.example.co.uk/path?q=1#top');
  assert.equal(ok('https://8.8.8.8/'), 'https://8.8.8.8/');
});

test('rejects missing or non-URL input', () => {
  assert.match(err(undefined), /required/);
  assert.match(err(''), /required/);
  assert.match(err('   '), /required/);
  assert.match(err(42), /required/);
  assert.match(err('not a url'), /not a valid URL/);
  assert.match(err('example.com'), /not a valid URL/); // no scheme
});

test('rejects non-http schemes', () => {
  for (const u of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.com']) {
    assert.match(err(u), /only http and https/, u);
  }
});

test('rejects URLs with credentials in them', () => {
  assert.match(err('https://paypal.com@evil.example'), /username or password/);
  assert.match(err('https://user:pass@example.com'), /username or password/);
});

test('rejects localhost and private network targets, including disguised ones', () => {
  for (const u of [
    'http://localhost:3000',
    'http://LOCALHOST./',
    'http://app.localhost',
    'http://printer.local',
    'http://127.0.0.1',
    'http://2130706433', // 127.0.0.1 as a single number
    'http://0x7f.1', // 127.0.0.1 in hex
    'http://10.1.2.3',
    'http://172.20.0.1',
    'http://192.168.1.1',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
  ]) {
    assert.match(err(u), /localhost or private/, u);
  }
  assert.equal(ok('http://172.32.0.1'), 'http://172.32.0.1/'); // just outside 172.16/12
});

test('rejects single-label hostnames', () => {
  assert.match(err('http://intranet/'), /public domain/);
});

test('rejects links to our own short domain', () => {
  const opts = { ownHost: 'lnk.example' };
  assert.match(err('https://lnk.example/abc', opts), /already a short link/);
  assert.equal(ok('https://other.example/abc', opts), 'https://other.example/abc');
});

test('rejects blocked domains and their subdomains only', () => {
  const opts = { blockedDomains: ['evil.example'] };
  assert.match(err('https://evil.example/x', opts), /not allowed/);
  assert.match(err('https://login.evil.example/x', opts), /not allowed/);
  assert.equal(ok('https://notevil.example/x', opts), 'https://notevil.example/x');
});

test('enforces the max length', () => {
  const base = 'https://example.com/';
  assert.ok(ok(base + 'a'.repeat(2048 - base.length)));
  assert.match(err(base + 'a'.repeat(2049 - base.length)), /too long/);
  // short input that grows past the limit once percent-encoded
  assert.match(err(base + 'é'.repeat(1000)), /too long/);
});

test('validateAlias accepts reasonable aliases', () => {
  for (const a of ['abc', 'my-link', 'Launch_2026', 'a'.repeat(16)]) {
    assert.equal(validateAlias(a).alias, a);
  }
});

test('validateAlias rejects bad aliases', () => {
  assert.match(validateAlias('ab').error, /3-16/);
  assert.match(validateAlias('a'.repeat(17)).error, /3-16/);
  assert.match(validateAlias('has space').error, /letters, numbers/);
  assert.match(validateAlias('emoji🙂').error, /letters, numbers/);
  assert.match(validateAlias('../etc').error, /letters, numbers/);
  assert.match(validateAlias('shorten').error, /reserved/);
  assert.match(validateAlias('Health').error, /reserved/);
  assert.match(validateAlias(123).error, /string/);
});

test('SHORT_CODE_PATTERN matches codes and aliases but not junk', () => {
  for (const c of ['1', 'aZl8N0y58M7', 'my-link']) assert.ok(SHORT_CODE_PATTERN.test(c), c);
  for (const c of ['', 'favicon.ico', 'a/b', 'x'.repeat(17)]) assert.ok(!SHORT_CODE_PATTERN.test(c), c);
});

test('validateExpiresAt accepts ISO dates and null', () => {
  assert.equal(validateExpiresAt(null).expiresAt, null);
  assert.equal(validateExpiresAt('2026-12-31T23:59:59Z').expiresAt.toISOString(), '2026-12-31T23:59:59.000Z');
  assert.equal(validateExpiresAt('2026-12-31').expiresAt.toISOString(), '2026-12-31T00:00:00.000Z');
  assert.ok(validateExpiresAt('2020-01-01T00:00:00Z').expiresAt); // past is fine, expires it now
});

test('validateExpiresAt rejects junk', () => {
  for (const v of ['tomorrow', '3', 3, '', '2026-13-45', undefined, {}]) {
    assert.match(validateExpiresAt(v).error, /ISO 8601/, String(v));
  }
});
