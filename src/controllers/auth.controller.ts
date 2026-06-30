import { Request, Response } from 'express';
import { z } from 'zod';
import { createFirebaseAccount, generatePasswordResetLink } from '../services/firebase.service.js';
import { sendPasswordResetEmail } from '../services/email.service.js';

const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().trim().min(2).max(80).optional(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
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

function isUserNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && String(error.code) === 'auth/user-not-found';
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

export async function forgotPassword(req: Request, res: Response) {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    const resetLink = await generatePasswordResetLink(email);
    await sendPasswordResetEmail({ recipientEmail: email, resetLink });

    return res.status(202).json({ message: 'If an account exists for that email, a password reset link has been sent.' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: err.flatten() });
    }

    if (isUserNotFoundError(err)) {
      return res.status(202).json({ message: 'If an account exists for that email, a password reset link has been sent.' });
    }

    console.error('Failed to send password reset email', err);
    return res.status(500).json({ error: 'Failed to send password reset email' });
  }
}
