// Managing existing links. Admin-token only for now; once there are accounts
// these become "your own links only".
import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { validateLongUrl, validateExpiresAt, SHORT_CODE_PATTERN } from '../validation.js';
import * as links from '../links.js';
import { getDetails, getStats } from '../url-store.js';
import { urlOptions, toResponse } from './urls.js';

export const adminRouter = Router();

adminRouter.use('/urls', requireAdmin);

adminRouter.param('shortCode', (req, res, next, shortCode) => {
  if (!SHORT_CODE_PATTERN.test(shortCode)) return notFound(res);
  next();
});

adminRouter.get('/urls/:shortCode', async (req, res) => {
  const row = await getDetails(req.params.shortCode);
  if (!row) return notFound(res);
  res.json(toDetails(row));
});

// PATCH /urls/:shortCode  { "url"?: "...", "expires_at"?: "2026-12-31T00:00:00Z" | null }
adminRouter.patch('/urls/:shortCode', async (req, res) => {
  const body = req.body ?? {};
  const changes = {};

  if ('url' in body) {
    const checked = validateLongUrl(body.url, urlOptions);
    if (checked.error) return res.status(400).json({ error: checked.error });
    changes.longUrl = checked.url;
  }
  if ('expires_at' in body) {
    const checked = validateExpiresAt(body.expires_at);
    if (checked.error) return res.status(400).json({ error: checked.error });
    changes.expiresAt = checked.expiresAt;
  }
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ error: 'nothing to update, send "url" and/or "expires_at"' });
  }

  const row = await links.update(req.params.shortCode, changes);
  if (!row) return notFound(res);
  res.json(toDetails(row));
});

adminRouter.delete('/urls/:shortCode', async (req, res) => {
  const deleted = await links.remove(req.params.shortCode);
  if (!deleted) return notFound(res);
  res.status(204).end();
});

adminRouter.get('/urls/:shortCode/stats', async (req, res) => {
  const stats = await getStats(req.params.shortCode);
  if (!stats) return notFound(res);
  res.json({ short_code: req.params.shortCode, ...stats });
});

function toDetails(row) {
  return { ...toResponse(row), is_custom: row.is_custom, click_count: Number(row.click_count) };
}

function notFound(res) {
  return res.status(404).json({ error: 'short link not found' });
}
