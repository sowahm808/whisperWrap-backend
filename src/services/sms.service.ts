import twilio from 'twilio';
import crypto from 'node:crypto';
import type { Twilio } from 'twilio';
import type { GeneratedWhisper } from '../types/whisper.types.js';

const MAX_SMS_BODY_LENGTH = 1500;

let client: Twilio | null = null;

export interface SmsDeliveryResult {
  sid: string;
  status: string;
}

export class SmsValidationError extends Error {
  constructor(message: string, public readonly code = 'invalid_phone_number') {
    super(message);
    this.name = 'SmsValidationError';
  }
}

function requiredEnv(name: 'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN'): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required Twilio environment variable: ${name}`);
  }

  return value;
}

export function twilioSender(): { messagingServiceSid: string } | { from: string } {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (messagingServiceSid) {
    if (!/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) {
      throw new Error('TWILIO_MESSAGING_SERVICE_SID must be a valid Twilio Messaging Service SID');
    }
    return { messagingServiceSid };
  }

  const from = process.env.TWILIO_PHONE_NUMBER?.trim();
  if (!from) {
    throw new Error(
      'Missing Twilio sender: set TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER',
    );
  }
  return { from: normalizePhoneForSms(from) };
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

export function phoneHash(phone: string): string {
  const pepper = process.env.SMS_PHONE_HASH_PEPPER;
  if (!pepper) throw new Error('Missing SMS_PHONE_HASH_PEPPER');
  return crypto.createHmac('sha256', pepper).update(normalizePhoneForSms(phone)).digest('hex');
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
    ...twilioSender(),
    to: normalizePhoneForSms(to),
    body: trimSmsBody(body),
  });

  return {
    sid: message.sid,
    status: message.status,
  };
}

export async function sendWhisperSms({
  recipientPhone,
  whisper,
  unwrapUrl,
}: {
  recipientPhone: string;
  whisper: GeneratedWhisper;
  unwrapUrl: string;
}): Promise<SmsDeliveryResult> {
  const body = [
    `Open your private Whisper: ${unwrapUrl}`,
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
