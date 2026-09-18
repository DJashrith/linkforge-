import { Router } from 'express';
import { pool } from '../db.js';
import { encode } from '../base62.js';

const MAX_URL_LENGTH = 2048;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

export const urlsRouter = Router();

// POST /shorten  { "url": "https://example.com/some/long/path" }
urlsRouter.post('/shorten', async (req, res) => {
  const longUrl = normalizeUrl(req.body?.url);
  if (!longUrl) {
    return res.status(400).json({ error: 'body must include "url": an absolute http(s) URL' });
  }

  // Reserve the ID first so the short code can be written in the same INSERT,
  // letting short_code stay NOT NULL instead of insert-then-update.
  const { rows: [{ id }] } = await pool.query(
    `SELECT nextval(pg_get_serial_sequence('urls', 'id')) AS id`,
  );
  const shortCode = encode(id);

  const { rows: [row] } = await pool.query(
    `INSERT INTO urls (id, short_code, long_url)
     VALUES ($1, $2, $3)
     RETURNING short_code, long_url, created_at, expires_at`,
    [id, shortCode, longUrl],
  );

  res.status(201).json({
    short_code: row.short_code,
    short_url: `${BASE_URL}/${row.short_code}`,
    long_url: row.long_url,
    created_at: row.created_at,
    expires_at: row.expires_at,
  });
});

function normalizeUrl(input) {
  if (typeof input !== 'string' || input.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}
