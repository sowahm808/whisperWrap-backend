import crypto from 'node:crypto';

export const tokenService = {
  generateSecureToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  },

  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  },
};

const configuredTtlHours = Number(process.env.SMS_CONSENT_TOKEN_TTL_HOURS ?? 48);
export const SMS_CONSENT_TOKEN_TTL_MS =
  (Number.isFinite(configuredTtlHours) && configuredTtlHours > 0 ? configuredTtlHours : 48) * 60 * 60 * 1000;
