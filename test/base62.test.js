import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../src/base62.js';

test('encodes known values', () => {
  assert.equal(encode(0), '0');
  assert.equal(encode(9), '9');
  assert.equal(encode(10), 'a');
  assert.equal(encode(35), 'z');
  assert.equal(encode(36), 'A');
  assert.equal(encode(61), 'Z');
  assert.equal(encode(62), '10');
  assert.equal(encode(3843), 'ZZ'); // 62^2 - 1
  assert.equal(encode(3844), '100'); // 62^2
});

test('accepts number, string, and bigint input', () => {
  assert.equal(encode(125), '21');
  assert.equal(encode('125'), '21'); // node-pg returns BIGINT as string
  assert.equal(encode(125n), '21');
});

test('handles the full BIGINT range', () => {
  const maxBigint = 9223372036854775807n; // Postgres BIGINT max
  const code = encode(maxBigint);
  assert.equal(code, 'aZl8N0y58M7');
  assert.equal(decode(code), maxBigint);
});

test('round-trips encode -> decode', () => {
  for (const n of [0n, 1n, 61n, 62n, 999_999n, 2n ** 53n + 1n]) {
    assert.equal(decode(encode(n)), n);
  }
});

test('code length only grows at powers of 62', () => {
  assert.equal(encode(61).length, 1);
  assert.equal(encode(62).length, 2);
  assert.equal(encode(62n ** 5n - 1n).length, 5);
  assert.equal(encode(62n ** 5n).length, 6);
});

test('different ids never share a code', () => {
  const seen = new Set();
  for (let i = 0; i < 20_000; i++) seen.add(encode(i));
  assert.equal(seen.size, 20_000);
});

test('generated codes never start with 0 (except id 0)', () => {
  // matters because "0abc" and "abc" decode to the same id
  for (let i = 1; i < 5_000; i++) assert.notEqual(encode(i)[0], '0');
});

test('rejects invalid input', () => {
  assert.throws(() => encode(-1), RangeError);
  assert.throws(() => encode(1.5), RangeError);
  assert.throws(() => decode(''), TypeError);
  assert.throws(() => decode('abc-'), RangeError);
});
