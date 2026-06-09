import { Request, Response } from 'express';
import { z } from 'zod';
import { createFirebaseAccount } from '../services/firebase.service.js';

const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().trim().min(2).max(80).optional(),
});

function getFirebaseErrorMessage(error: unknown): { status: number; error: string } {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

  switch (code) {
    case 'auth/email-already-exists':
      return { status: 409, error: 'An account with this email already exists' };
    case 'auth/invalid-password':
      return { status: 400, error: 'Password does not meet Firebase requirements' };
    case 'auth/invalid-email':
      return { status: 400, error: 'Invalid email address' };
    default:
      return { status: 500, error: 'Failed to create account' };
  }
}

export async function signUp(req: Request, res: Response) {
  try {
    const input = signUpSchema.parse(req.body);
    const account = await createFirebaseAccount(input);

    return res.status(201).json(account);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.flatten() });
    }

    const { status, error } = getFirebaseErrorMessage(err);
    return res.status(status).json({ error });
  }
}
