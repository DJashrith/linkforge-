export const PORT = Number(process.env.PORT ?? 3000);

// Public origin used to build short links in API responses.
export const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');

// Comma-separated domains that can't be shortened (subdomains are blocked too).
export const BLOCKED_DOMAINS = (process.env.BLOCKED_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Off switch for benchmarking the redirect path without the cache.
export const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';

// Upper bound on how long a redirect target is cached. Also bounds how stale a
// link can get if Redis is unreachable at the moment it's updated or deleted.
export const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 3600);

// Bearer token for the /urls management endpoints until real accounts exist.
// Empty means those endpoints are switched off.
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

// Express "trust proxy" setting, so req.ip is the visitor and not the load balancer.
// e.g. "1" (one proxy hop), "loopback", "true". Unset = don't trust X-Forwarded-For.
export const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

function parseTrustProxy(value) {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
