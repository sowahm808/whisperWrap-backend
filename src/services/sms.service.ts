import twilio from 'twilio';
import type { Twilio } from 'twilio';

let client: Twilio | null = null;

function ensureClient(): Twilio {
  if (client) return client;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error('Missing Twilio config env variables');
  }

  client = twilio(accountSid, authToken);
  return client;
}

export interface SmsDeliveryResult {
  sid: string;
  status: string;
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
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) throw new Error('Missing TWILIO_PHONE_NUMBER');

  const message = await ensureClient().messages.create({
    from,
    to: recipientPhone,
    body: `Hi ${recipientName || 'there'}, ${senderName || 'A friend'} sent you a WhisperWrap. Would you like to unwrap it? ${unwrapLink}`,
  });

  return {
    sid: message.sid,
    status: message.status,
  };
}
