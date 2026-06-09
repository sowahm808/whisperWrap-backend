import { NextFunction, Request, Response } from 'express';
import { ensureUserProfile, getFirestore, verifyFirebaseToken } from '../services/firebase.service.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        email?: string;
        name?: string;
      };
      authError?: 'missing_token' | 'invalid_token' | 'profile_init_failed';
    }
  }
}

function extractBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    return auth.replace('Bearer ', '').trim();
  }

  const firebaseToken = req.header('X-Firebase-ID-Token')?.trim();
  if (firebaseToken) {
    return firebaseToken;
  }

  return undefined;
}

async function attachAuthenticatedUser(req: Request): Promise<void> {
  const token = extractBearerToken(req);
  if (!token) {
    req.authError = 'missing_token';
    return;
  }

  try {
    const decoded = await verifyFirebaseToken(token);
    req.user = { uid: decoded.uid, email: decoded.email, name: decoded.name };
  } catch {
    req.authError = 'invalid_token';
    return;
  }

  try {
    await ensureUserProfile(req.user);
  } catch {
    req.authError = 'profile_init_failed';
  }
}

function publicGenerationEnabled(): boolean {
  return process.env.PUBLIC_WHISPER_GENERATION !== 'false';
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  await attachAuthenticatedUser(req);

  if (req.authError === 'missing_token') {
    return res.status(401).json({ code: 'missing_token', error: 'Missing bearer token' });
  }

  if (req.authError === 'invalid_token') {
    return res.status(401).json({ code: 'invalid_token', error: 'Invalid token' });
  }

  if (req.authError === 'profile_init_failed') {
    return res.status(500).json({ code: 'profile_init_failed', error: 'Failed to initialize user profile' });
  }

  return next();
}

export async function allowPublicGeneration(req: Request, res: Response, next: NextFunction) {
  await attachAuthenticatedUser(req);

  if (req.authError === 'profile_init_failed') {
    return res.status(500).json({ code: 'profile_init_failed', error: 'Failed to initialize user profile' });
  }

  if (!req.user && !publicGenerationEnabled()) {
    const code = req.authError === 'invalid_token' ? 'invalid_token' : 'missing_token';
    const error = req.authError === 'invalid_token' ? 'Invalid token' : 'Missing bearer token';
    return res.status(401).json({ code, error });
  }

  return next();
}

export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.uid) return res.status(401).json({ code: 'unauthorized', error: 'Unauthorized' });

    const userDoc = await getFirestore().collection('users').doc(req.user.uid).get();
    const subscriptionStatus = userDoc.data()?.subscriptionStatus;

    if (subscriptionStatus !== 'active') {
      return res.status(403).json({ code: 'subscription_required', error: 'Subscription required' });
    }

    return next();
  } catch {
    return res.status(500).json({ code: 'subscription_check_failed', error: 'Failed to validate subscription' });
  }
}

export async function requireActiveSubscriptionForAuthenticatedUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return next();
  return requireActiveSubscription(req, res, next);
}
