import dotenv from 'dotenv';
import express from 'express';
import whisperRoutes from './routes/whisper.routes.js';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api/whispers', whisperRoutes);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`WhisperWrap backend running on port ${port}`);
});
