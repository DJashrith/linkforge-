// Producer side of click tracking. The redirect handler drops an event onto a
// Redis Stream and moves on; the worker (src/worker.js) writes them to Postgres.
import { randomUUID } from 'node:crypto';
import { redis } from '../redis.js';

export const STREAM = 'clicks';
export const GROUP = 'click-writers';

// Safety valve. Processed events are deleted, so the stream is normally tiny.
// If the worker is down long enough for this many to pile up, the oldest ones
// get dropped rather than letting Redis run out of memory.
const MAX_BACKLOG = 1_000_000;

let lastLogged = 0;

/** Fire and forget. Never throws and never makes the redirect wait. */
export function trackClick(shortCode, req) {
  redis
    .xadd(
      STREAM, 'MAXLEN', '~', MAX_BACKLOG, '*',
      'id', randomUUID(),
      'code', shortCode,
      'ts', Date.now(),
      'ip', req.ip ?? '',
      'ref', clip(req.get('referer'), 2048),
      'ua', clip(req.get('user-agent'), 512),
    )
    .catch((err) => {
      if (Date.now() - lastLogged < 10_000) return;
      lastLogged = Date.now();
      console.error(`dropping click events, redis unavailable: ${err.message}`);
    });
}

function clip(value, max) {
  return value ? value.slice(0, max) : '';
}
