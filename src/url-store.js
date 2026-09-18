import { pool } from './db.js';
import { encode } from './base62.js';

// How many ids we'll burn looking for a generated code that isn't taken by an alias.
const MAX_CODE_ATTEMPTS = 10;
const COLUMNS = 'short_code, long_url, created_at, expires_at';
const DETAIL_COLUMNS = `${COLUMNS}, is_custom, click_count`;
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

/** Everything the redirect needs (expired links included, the caller decides). */
export async function findByCode(shortCode) {
  const { rows } = await pool.query(
    'SELECT short_code, long_url, expires_at FROM urls WHERE short_code = $1',
    [shortCode],
  );
  return rows[0] ?? null;
}

export async function getDetails(shortCode) {
  const { rows } = await pool.query(
    `SELECT ${DETAIL_COLUMNS} FROM urls WHERE short_code = $1`,
    [shortCode],
  );
  return rows[0] ?? null;
}

/**
 * @param {{ longUrl?: string, expiresAt?: Date | null }} changes only the keys present are updated
 */
export async function update(shortCode, changes) {
  const sets = [];
  const values = [shortCode];
  if ('longUrl' in changes) {
    values.push(changes.longUrl);
    sets.push(`long_url = $${values.length}`);
  }
  if ('expiresAt' in changes) {
    values.push(changes.expiresAt);
    sets.push(`expires_at = $${values.length}`);
  }

  const { rows } = await pool.query(
    `UPDATE urls SET ${sets.join(', ')} WHERE short_code = $1 RETURNING ${DETAIL_COLUMNS}`,
    values,
  );
  return rows[0] ?? null;
}

/** @returns {Promise<boolean>} whether anything was deleted */
export async function remove(shortCode) {
  const { rowCount } = await pool.query('DELETE FROM urls WHERE short_code = $1', [shortCode]);
  return rowCount > 0;
}

export async function getStats(shortCode, { days = 30, top = 10 } = {}) {
  const { rows: [link] } = await pool.query(
    'SELECT id, click_count FROM urls WHERE short_code = $1',
    [shortCode],
  );
  if (!link) return null;

  const [byDay, countries, referrers] = await Promise.all([
    pool.query(
      `SELECT to_char(date_trunc('day', clicked_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              count(*)::int AS clicks
       FROM click_events
       WHERE url_id = $1 AND clicked_at > now() - make_interval(days => $2)
       GROUP BY 1 ORDER BY 1`,
      [link.id, days],
    ),
    pool.query(
      `SELECT coalesce(country, '??') COLLATE "C" AS country, count(*)::int AS clicks
       FROM click_events WHERE url_id = $1
       GROUP BY 1 ORDER BY clicks DESC, country LIMIT $2`,
      [link.id, top],
    ),
    pool.query(
      `SELECT coalesce(substring(referrer FROM '^[a-zA-Z]+://([^/:?#]+)'), 'direct') COLLATE "C" AS referrer,
              count(*)::int AS clicks
       FROM click_events WHERE url_id = $1
       GROUP BY 1 ORDER BY clicks DESC, referrer LIMIT $2`,
      [link.id, top],
    ),
  ]);

  return {
    total_clicks: Number(link.click_count),
    clicks_by_day: byDay.rows,
    top_countries: countries.rows,
    top_referrers: referrers.rows,
  };
}
