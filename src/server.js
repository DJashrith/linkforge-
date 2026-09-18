import { app } from './app.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { PORT } from './config.js';

// Fail fast if either store is unreachable at startup. Once running, a Redis
// outage only costs speed (cache misses) and click events, not redirects.
await pool.query('SELECT 1');
await redis.connect();

const server = app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await Promise.allSettled([pool.end(), redis.quit()]);
      process.exit(0);
    });
  });
}
