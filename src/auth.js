import { createHash, timingSafeEqual } from 'node:crypto';
import { ADMIN_TOKEN } from './config.js';

// Stand-in until there are real user accounts: the /urls management endpoints
// need "Authorization: Bearer <ADMIN_TOKEN>".
export function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'management endpoints are disabled (ADMIN_TOKEN is not set)' });
  }
  const [scheme, token] = (req.get('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token || !sameToken(token, ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'missing or invalid admin token' });
  }
  next();
}

// Hash both sides so timingSafeEqual gets equal-length buffers and the
// comparison time doesn't leak anything about the real token.
function sameToken(a, b) {
  const hash = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}
