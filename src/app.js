import express from 'express';
import { TRUST_PROXY } from './config.js';
import { adminRouter } from './routes/admin.js';
import { urlsRouter } from './routes/urls.js';

export const app = express();

app.set('trust proxy', TRUST_PROXY);
app.use(express.json({ limit: '10kb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use(adminRouter);
app.use(urlsRouter);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Express 5 forwards rejected promises from async handlers here.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});
