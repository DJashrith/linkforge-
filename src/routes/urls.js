import { Router } from 'express';
import { BASE_URL, BLOCKED_DOMAINS } from '../config.js';
import { validateLongUrl, validateAlias, SHORT_CODE_PATTERN } from '../validation.js';
import * as links from '../links.js';
import { trackClick } from '../clicks/queue.js';

export const urlOptions = { ownHost: new URL(BASE_URL).host, blockedDomains: BLOCKED_DOMAINS };

export const urlsRouter = Router();

// POST /shorten  { "url": "https://example.com/long", "alias": "optional-name" }
urlsRouter.post('/shorten', async (req, res) => {
  const checked = validateLongUrl(req.body?.url, urlOptions);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const longUrl = checked.url;

  const rawAlias = req.body?.alias;
  if (rawAlias !== undefined && rawAlias !== null && rawAlias !== '') {
    const aliasCheck = validateAlias(rawAlias);
    if (aliasCheck.error) return res.status(400).json({ error: aliasCheck.error });

    const result = await links.createWithAlias(longUrl, aliasCheck.alias);
    if (!result) return res.status(409).json({ error: `alias "${aliasCheck.alias}" is already taken` });
    return res.status(result.created ? 201 : 200).json(toResponse(result.row));
  }

  const existing = await links.findReusable(longUrl);
  if (existing) return res.status(200).json(toResponse(existing));

  const row = await links.createWithGeneratedCode(longUrl);
  res.status(201).json(toResponse(row));
});

// GET /:shortCode  ->  302 to the original URL
urlsRouter.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  if (!SHORT_CODE_PATTERN.test(shortCode)) {
    return res.status(404).json({ error: 'short link not found' });
  }

  const result = await links.resolve(shortCode);
  if (result.status === 'found') {
    res.redirect(302, result.longUrl);
    // After the response, and not awaited. HEAD is skipped so link-preview
    // bots checking the target don't count as visits.
    if (req.method === 'GET') trackClick(shortCode, req);
    return;
  }
  if (result.status === 'expired') return res.status(410).json({ error: 'this link has expired' });
  res.status(404).json({ error: 'short link not found' });
});

export function toResponse(row) {
  return {
    short_code: row.short_code,
    short_url: `${BASE_URL}/${row.short_code}`,
    long_url: row.long_url,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}
