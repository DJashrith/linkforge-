// Ties Postgres (source of truth) and the Redis cache together, so every write
// path updates the cache and every read path goes through it.
import * as store from './url-store.js';
import * as cache from './cache.js';

/**
 * @returns {Promise<{ status: 'found', longUrl: string } | { status: 'expired' } | { status: 'missing' }>}
 */
export async function resolve(shortCode) {
  const cached = await cache.get(shortCode);
  if (cached) return toResult(cached);

  const entry = cache.entryFor(await store.findByCode(shortCode));
  cache.fill(shortCode, entry); // not awaited: the visitor doesn't need to wait for this
  return toResult(entry.value);
}

export const findReusable = store.findReusable;

export async function createWithGeneratedCode(longUrl) {
  const row = await store.createWithGeneratedCode(longUrl);
  await cache.put(row.short_code, cache.entryFor(row));
  return row;
}

export async function createWithAlias(longUrl, alias) {
  const result = await store.createWithAlias(longUrl, alias);
  // Overwrites a cached "missing" marker from someone visiting /alias before it existed.
  if (result?.created) await cache.put(alias, cache.entryFor(result.row));
  return result;
}

export async function update(shortCode, changes) {
  const row = await store.update(shortCode, changes);
  if (row) await cache.put(shortCode, cache.entryFor(row));
  return row;
}

export async function remove(shortCode) {
  const deleted = await store.remove(shortCode);
  if (deleted) await cache.put(shortCode, cache.entryFor(null));
  return deleted;
}

function toResult(value) {
  if (value === cache.MISSING) return { status: 'missing' };
  if (value === cache.EXPIRED) return { status: 'expired' };
  return { status: 'found', longUrl: value };
}
