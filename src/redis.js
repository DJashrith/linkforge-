import { Redis } from 'ioredis';
import { REDIS_URL } from './config.js';

/**
 * Connection used by the web server. If Redis goes down, commands fail straight
 * away (instead of queueing until it comes back) and anything slower than 250ms
 * is treated as a failure, so a Redis problem makes redirects fall back to
 * Postgres rather than hang.
 */
export const redis = createRedis({ enableOfflineQueue: false, commandTimeout: 250 });

export function createRedis(options = {}) {
  const client = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, ...options });

  // ioredis emits an error on every failed reconnect attempt; log at most one every 10s.
  let lastLogged = 0;
  client.on('error', (err) => {
    if (Date.now() - lastLogged < 10_000) return;
    lastLogged = Date.now();
    // connection refused comes through as an AggregateError with an empty message
    console.error(`redis: ${err.message || err.code || err}`);
  });
  return client;
}
