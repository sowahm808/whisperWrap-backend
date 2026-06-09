import { NextFunction, Request, Response } from 'express';
import { ensureUserProfile, getFirestore, verifyFirebaseToken } from '../services/firebase.service.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        email?: string;
      };
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const decoded = await verifyFirebaseToken(auth.replace('Bearer ', '').trim());
    req.user = { uid: decoded.uid, email: decoded.email };
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    await ensureUserProfile(req.user);
    return next();
  } catch {
    return res.status(500).json({ error: 'Failed to initialize user profile' });
  }
}

export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user?.uid) return res.status(401).json({ error: 'Unauthorized' });

    const userDoc = await getFirestore().collection('users').doc(req.user.uid).get();
    const subscriptionStatus = userDoc.data()?.subscriptionStatus;

    if (subscriptionStatus !== 'active') {
      return res.status(403).json({ error: 'Subscription required' });
    }

    next();
  } catch {
    return res.status(500).json({ error: 'Failed to validate subscription' });
  }
}
