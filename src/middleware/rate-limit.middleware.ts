import type { NextFunction, Request, Response } from 'express';

const requests = new Map<string, { count: number; resetAt: number }>();

export function consentRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = requests.get(key);
  const entry = !current || current.resetAt <= now
    ? { count: 1, resetAt: now + 15 * 60_000 }
    : { ...current, count: current.count + 1 };
  requests.set(key, entry);
  if (entry.count > 30) return res.status(429).json({ error: 'rate_limit_exceeded' });
  return next();
}
