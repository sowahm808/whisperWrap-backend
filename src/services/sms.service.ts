import twilio from 'twilio';
import type { Twilio } from 'twilio';
import type { GeneratedWhisper } from '../types/whisper.types.js';

const MAX_SMS_BODY_LENGTH = 1500;

let client: Twilio | null = null;

export interface SmsDeliveryResult {
  sid: string;
  status: string;
}

export class SmsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsValidationError';
  }
}

function requiredEnv(name: 'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_PHONE_NUMBER'): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required Twilio environment variable: ${name}`);
  }

  return value;
}

function ensureClient(): Twilio {
  if (client) return client;

  client = twilio(requiredEnv('TWILIO_ACCOUNT_SID'), requiredEnv('TWILIO_AUTH_TOKEN'));
  return client;
}

export function normalizePhoneForSms(phone: string): string {
  const trimmed = phone.trim();

  if (trimmed.startsWith('+')) {
    const e164 = `+${trimmed.slice(1).replace(/\D/g, '')}`;
    if (/^\+[1-9]\d{7,14}$/.test(e164)) return e164;
    throw new SmsValidationError('Recipient phone number must be a valid E.164 number.');
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;

  throw new SmsValidationError(
    'Recipient phone number must be in E.164 format or a valid 10-digit US number.',
  );
}

function compact(value?: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function trimSmsBody(body: string): string {
  if (body.length <= MAX_SMS_BODY_LENGTH) return body;
  return `${body.slice(0, MAX_SMS_BODY_LENGTH - 1).trimEnd()}…`;
}

async function sendSms(to: string, body: string): Promise<SmsDeliveryResult> {
  const message = await ensureClient().messages.create({
    from: requiredEnv('TWILIO_PHONE_NUMBER'),
    to: normalizePhoneForSms(to),
    body: trimSmsBody(body),
  });

  return {
    sid: message.sid,
    status: message.status,
  };
}

export async function sendConsentSms({
  recipientPhone,
  recipientName,
  senderName,
  unwrapLink,
}: {
  recipientPhone: string;
  recipientName: string;
  senderName: string;
  unwrapLink: string;
}): Promise<SmsDeliveryResult> {
  return sendSms(
    recipientPhone,
    `Hi ${compact(recipientName) || 'there'}, ${compact(senderName) || 'A friend'} sent you a WhisperWrap. Would you like to unwrap it? ${unwrapLink}`,
  );
}

export async function sendWhisperSms({
  recipientPhone,
  whisper,
}: {
  recipientPhone: string;
  whisper: GeneratedWhisper;
}): Promise<SmsDeliveryResult> {
  const body = [
    compact(whisper.message),
    whisper.scriptureReference || whisper.scriptureText
      ? `Scripture: ${compact(whisper.scriptureReference)}${whisper.scriptureReference && whisper.scriptureText ? ' — ' : ''}${compact(whisper.scriptureText)}`
      : '',
    whisper.shortPrayer ? `Prayer: ${compact(whisper.shortPrayer)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return sendSms(recipientPhone, body);
}
