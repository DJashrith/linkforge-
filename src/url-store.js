import { pool } from './db.js';
import { encode } from './base62.js';

// How many ids we'll burn looking for a generated code that isn't taken by an alias.
const MAX_CODE_ATTEMPTS = 10;
const COLUMNS = 'short_code, long_url, created_at, expires_at';
const NOT_EXPIRED = '(expires_at IS NULL OR expires_at > now())';

/** Existing live generated link for this URL, so resubmitting doesn't create duplicates. */
export async function findReusable(longUrl) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM urls
     WHERE long_url = $1 AND NOT is_custom AND ${NOT_EXPIRED}
     ORDER BY id LIMIT 1`,
    [longUrl],
  );
  return rows[0] ?? null;
}

/**
 * Generated codes come from base62(id), but a custom alias may already be sitting
 * on that code (someone picked "abc" before the id reached 39134). The UNIQUE
 * constraint catches it; we skip that id and take the next one.
 */
export async function createWithGeneratedCode(longUrl) {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const { rows: [{ id }] } = await pool.query(
      `SELECT nextval(pg_get_serial_sequence('urls', 'id')) AS id`,
    );
    const { rows } = await pool.query(
      `INSERT INTO urls (id, short_code, long_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (short_code) DO NOTHING
       RETURNING ${COLUMNS}`,
      [id, encode(id), longUrl],
    );
    if (rows[0]) return rows[0];
  }
  throw new Error(`no free short code after ${MAX_CODE_ATTEMPTS} attempts`);
}

/**
 * @returns {{ row, created: boolean } | null} null when the alias belongs to a different URL
 */
export async function createWithAlias(longUrl, alias) {
  const { rows } = await pool.query(
    `INSERT INTO urls (short_code, long_url, is_custom)
     VALUES ($1, $2, true)
     ON CONFLICT (short_code) DO NOTHING
     RETURNING ${COLUMNS}`,
    [alias, longUrl],
  );
  if (rows[0]) return { row: rows[0], created: true };

  // Taken. If it's taken by this exact URL, treat the request as a harmless retry.
  const { rows: [existing] } = await pool.query(
    `SELECT ${COLUMNS} FROM urls WHERE short_code = $1`,
    [alias],
  );
  if (existing?.long_url === longUrl) return { row: existing, created: false };
  return null;
}

/**
 * Looks up a code for redirecting and counts the click in the same query.
 * @returns {{ status: 'found', longUrl: string } | { status: 'expired' } | { status: 'missing' }}
 */
export async function resolve(shortCode) {
  const { rows: [hit] } = await pool.query(
    `UPDATE urls SET click_count = click_count + 1
     WHERE short_code = $1 AND ${NOT_EXPIRED}
     RETURNING long_url`,
    [shortCode],
  );
  if (hit) return { status: 'found', longUrl: hit.long_url };

  const { rowCount } = await pool.query('SELECT 1 FROM urls WHERE short_code = $1', [shortCode]);
  return { status: rowCount ? 'expired' : 'missing' };
}
