import crypto from 'node:crypto';

export const tokenService = {
  generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
  },
};
