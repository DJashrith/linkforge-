export const PORT = Number(process.env.PORT ?? 3000);

// Public origin used to build short links in API responses.
export const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');

// Comma-separated domains that can't be shortened (subdomains are blocked too).
export const BLOCKED_DOMAINS = (process.env.BLOCKED_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
