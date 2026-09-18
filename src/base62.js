// Base62 converts a numeric row ID into a short, URL-safe code and back.
// IDs are handled as BigInt because Postgres BIGINT exceeds Number.MAX_SAFE_INTEGER,
// and node-pg returns BIGINT columns as strings.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = BigInt(ALPHABET.length);

/**
 * @param {bigint | number | string} id  non-negative integer
 * @returns {string}
 */
export function encode(id) {
  let n = BigInt(id); // throws on non-integers like 1.5 or 'abc'
  if (n < 0n) throw new RangeError(`id must be non-negative, got ${id}`);
  if (n === 0n) return ALPHABET[0];

  let code = '';
  while (n > 0n) {
    code = ALPHABET[Number(n % BASE)] + code;
    n /= BASE; // BigInt division truncates
  }
  return code;
}

/**
 * @param {string} code
 * @returns {bigint}
 */
export function decode(code) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new TypeError('code must be a non-empty string');
  }

  let n = 0n;
  for (const ch of code) {
    const digit = ALPHABET.indexOf(ch);
    if (digit === -1) throw new RangeError(`invalid base62 character: '${ch}'`);
    n = n * BASE + BigInt(digit);
  }
  return n;
}
