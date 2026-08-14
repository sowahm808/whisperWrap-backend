import type { Request, Response } from 'express';
import twilio from 'twilio';
import { firebaseAdmin, getFirestore } from '../services/firebase.service.js';
import { normalizePhoneForSms, phoneHash, SmsValidationError } from '../services/sms.service.js';
import type { WhisperRecord } from '../types/whisper.types.js';

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

function twiml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message}</Message></Response>`;
}

export async function inboundSmsWebhook(req: Request, res: Response) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.header('x-twilio-signature') ?? '';
  const url = process.env.TWILIO_INBOUND_WEBHOOK_URL ?? `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  // Webhook data is never trusted without Twilio signature validation, in every environment.
  if (!authToken || !signature || !twilio.validateRequest(authToken, signature, url, req.body)) {
    return res.status(403).send('invalid_signature');
  }
  try {
    const phone = normalizePhoneForSms(String(req.body.From ?? ''));
    const keyword = String(req.body.Body ?? '').trim().toUpperCase();
    const db = getFirestore();
    if (STOP_WORDS.has(keyword)) {
      const now = firebaseAdmin.firestore.FieldValue.serverTimestamp();
      const matches = await db.collection('whispers').where('recipientPhone', '==', phone).get();
      const batch = db.batch();
      const hashedPhone = phoneHash(phone);
      const suppressionRef = db.collection('smsSuppressions').doc(hashedPhone);
      const existingSuppression = await suppressionRef.get();
      batch.set(suppressionRef, {
        phoneHash: hashedPhone,
        phoneLast4: phone.slice(-4),
        reason: 'recipient_opt_out',
        source: 'twilio-inbound',
        ...(existingSuppression.exists ? {} : { createdAt: now }),
        updatedAt: now,
      }, { merge: true });
      for (const doc of matches.docs) {
        const whisper = doc.data() as WhisperRecord;
        if (whisper.smsConsent?.status === 'granted') batch.update(doc.ref, { 'smsConsent.status': 'revoked', 'smsConsent.revokedAt': now, updatedAt: now });
      }
      batch.set(db.collection('smsConsentEvents').doc(), { event: 'sms_consent_revoked', phoneHash: hashedPhone, phoneLast4: phone.slice(-4), reason: 'STOP', source: 'twilio-inbound', createdAt: now });
      await batch.commit();
      return res.type('text/xml').send(twiml('WhisperWrap: You are unsubscribed and will receive no further messages. Reply START to request a new consent link.'));
    }
    if (keyword === 'START') return res.type('text/xml').send(twiml('WhisperWrap: Messaging remains disabled until you explicitly consent on a new secure consent page.'));
    if (keyword === 'HELP' || keyword === 'INFO') return res.type('text/xml').send(twiml(`WhisperWrap support: ${process.env.SMS_SUPPORT_CONTACT ?? 'support@whisperwrapapp.org'}. Reply STOP to unsubscribe.`));
    return res.type('text/xml').send(twiml('WhisperWrap: Reply HELP for support or STOP to unsubscribe.'));
  } catch (error) {
    if (error instanceof SmsValidationError) return res.status(400).send('invalid_sender');
    console.error({ event: 'sms.webhook.failed', message: error instanceof Error ? error.message : 'unknown' });
    return res.status(500).send('webhook_failed');
  }
}
