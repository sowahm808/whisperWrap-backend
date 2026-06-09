import dotenv from 'dotenv';
import express from 'express';
import authRoutes from './routes/auth.routes.js';
import whisperRoutes from './routes/whisper.routes.js';

dotenv.config();

const app = express();

const configuredOrigins = (process.env.CORS_ORIGIN ?? process.env.FRONTEND_ORIGIN ?? '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const allowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : ['*'];

app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;
  const allowAnyOrigin = allowedOrigins.includes('*');
  const allowedOrigin = requestOrigin && (allowAnyOrigin || allowedOrigins.includes(requestOrigin)) ? requestOrigin : undefined;

  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Origin', allowedOrigin ?? (allowAnyOrigin ? '*' : allowedOrigins[0]));
  res.header('Access-Control-Allow-Headers', 'Authorization, X-Firebase-ID-Token, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/whispers', whisperRoutes);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`WhisperWrap backend running on port ${port}`);
});
