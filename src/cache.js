// Redis cache for short_code -> redirect target.
//
// Every cache call swallows its own errors: if Redis is down we just go to Postgres.
//
// Invalidation rules:
// - Reads that miss fill the cache with SET ... NX, so they never overwrite a value.
// - Writes (create/update/delete) overwrite the key right after the Postgres write.
// That ordering matters: a slow reader that fetched the old row from Postgres can't
// put the old value back after an update, because the key already exists by then.

import { redis } from './redis.js';
import { CACHE_ENABLED, CACHE_TTL_SECONDS } from './config.js';

// Cached values are either a long URL or one of these markers. URLs always start
// with "http", so the two can't be confused.
export const MISSING = '!missing';
export const EXPIRED = '!expired';

// Short, so a code that doesn't exist yet isn't "stuck" as missing for long if a
// write-through ever fails.
const MISSING_TTL_SECONDS = 60;

const key = (code) => `link:${code}`;

/** @returns {Promise<string | null>} null on a miss or if Redis is unavailable */
export async function get(code) {
  if (!CACHE_ENABLED) return null;
  try {
    return await redis.get(key(code));
  } catch (err) {
    logError('get', err);
    return null;
  }
}

/** Fill after a miss. Won't replace anything already there. */
export function fill(code, entry) {
  return set(code, entry, true);
}

/** Write-through after a change in Postgres. Replaces whatever is cached. */
export function put(code, entry) {
  return set(code, entry, false);
}

/**
 * What to cache for a urls row (or null when there's no row).
 * @returns {{ value: string, ttl: number }}
 */
export function entryFor(row, now = Date.now()) {
  if (!row) return { value: MISSING, ttl: MISSING_TTL_SECONDS };
  if (!row.expires_at) return { value: row.long_url, ttl: CACHE_TTL_SECONDS };

  const secondsLeft = Math.floor((new Date(row.expires_at).getTime() - now) / 1000);
  if (secondsLeft <= 0) return { value: EXPIRED, ttl: CACHE_TTL_SECONDS };
  // never cache a link past its expiry
  return { value: row.long_url, ttl: Math.min(CACHE_TTL_SECONDS, secondsLeft) };
}

async function set(code, { value, ttl }, onlyIfAbsent) {
  if (!CACHE_ENABLED) return;
  const args = [key(code), value, 'EX', ttl];
  if (onlyIfAbsent) args.push('NX');
  try {
    await redis.set(...args);
  } catch (err) {
    logError('set', err);
    // A failed fill is harmless. A failed write-through means Redis may still
    // hold the old value once it's reachable again, so delete it when we can.
    if (!onlyIfAbsent) queueInvalidation(code);
  }
}

// Keys whose write-through failed. Retried every few seconds until Redis answers.
// (Only lives in memory, so a restart during an outage loses it. The TTL is the backstop.)
const pendingInvalidations = new Set();
let retryTimer = null;

function queueInvalidation(code) {
  pendingInvalidations.add(key(code));
  retryTimer ??= setInterval(flushInvalidations, 5000).unref();
}

export async function flushInvalidations() {
  if (pendingInvalidations.size === 0) return;
  const keys = [...pendingInvalidations];
  try {
    await redis.del(...keys);
  } catch {
    return; // still down, try again next tick
  }
  for (const k of keys) pendingInvalidations.delete(k);
  if (pendingInvalidations.size === 0) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  console.log(`redis is back, cleared ${keys.length} key(s) that changed during the outage`);
}

let lastLogged = 0;
function logError(op, err) {
  if (Date.now() - lastLogged < 10_000) return;
  lastLogged = Date.now();
  console.error(`cache ${op} failed, falling back to postgres: ${err.message}`);
}
