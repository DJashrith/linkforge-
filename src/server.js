import { app } from './app.js';
import { pool } from './db.js';
import { PORT } from './config.js';

// Fail fast if the database is unreachable rather than erroring on the first request.
await pool.query('SELECT 1');

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});
