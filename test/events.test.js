import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClickRow } from '../src/clicks/events.js';

const ID = '3f0c6c1e-3a52-4c55-9b53-0d7c6a1e2b10';
const fields = (o) => Object.entries(o).flat();

test('turns a stream entry into a click row with location', () => {
  const row = toClickRow(fields({
    id: ID, code: 'abc', ts: '1767225600000', ip: '81.2.69.160',
    ref: 'https://example.com/', ua: 'curl/8',
  }));
  assert.equal(row.event_id, ID);
  assert.equal(row.code, 'abc');
  assert.equal(row.clicked_at, '2026-01-01T00:00:00.000Z');
  assert.equal(row.referrer, 'https://example.com/');
  assert.equal(row.user_agent, 'curl/8');
  assert.equal(row.country, 'GB');
  assert.equal(row.region, 'ENG');
});

test('handles IPv4-mapped IPv6 addresses', () => {
  assert.equal(toClickRow(fields({ id: ID, code: 'a', ts: '1', ip: '::ffff:8.8.8.8' })).country, 'US');
});

test('missing or private IPs and empty headers become nulls', () => {
  for (const ip of ['', '127.0.0.1', '::1', '10.0.0.1']) {
    const row = toClickRow(fields({ id: ID, code: 'a', ts: '1', ip, ref: '', ua: '' }));
    assert.equal(row.country, null, ip);
    assert.equal(row.city, null, ip);
    assert.equal(row.referrer, null);
    assert.equal(row.user_agent, null);
  }
});

test('rejects malformed entries', () => {
  assert.equal(toClickRow(null), null); // trimmed from the stream while pending
  assert.equal(toClickRow(fields({ id: 'nope', code: 'a', ts: '1' })), null);
  assert.equal(toClickRow(fields({ id: ID, code: 'a/b', ts: '1' })), null);
  assert.equal(toClickRow(fields({ id: ID, code: 'a', ts: 'soon' })), null);
  assert.equal(toClickRow(fields({ code: 'a', ts: '1' })), null);
});
