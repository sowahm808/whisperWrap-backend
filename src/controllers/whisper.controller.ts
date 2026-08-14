import { Request, Response } from 'express';
import { z } from 'zod';
import {
  PRIVACY_POLICY_VERSION,
  SMS_CONSENT_SOURCE,
  SMS_DISCLOSURE_TEXT,
  SMS_DISCLOSURE_VERSION,
  TERMS_VERSION,
} from '../config/sms-compliance.js';
import { sendConsentEmail } from '../services/email.service.js';
import {
  SmsValidationError,
  normalizePhoneForSms,
  phoneHash,
  sendWhisperSms,
} from '../services/sms.service.js';
import { firebaseAdmin, getFirestore, getStorageBucket } from '../services/firebase.service.js';
import { GeminiGenerationError, generateWhisperContent } from '../services/gemini.service.js';
import { SMS_CONSENT_TOKEN_TTL_MS, tokenService } from '../services/token.service.js';
import { RecipientGender, WhisperRecord, WhisperStatus } from '../types/whisper.types.js';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 .()\-]{7,25}$/, 'Invalid phone number')
  .optional()
  .or(z.literal('').transform(() => undefined));

const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform(value => value.toLowerCase())
  .optional()
  .or(z.literal('').transform(() => undefined));

const createSchema = z
  .object({
    recipientName: z.string().trim().min(2).max(80).transform(normalizeText),
    recipientAddressName: z
      .string()
      .trim()
      .max(80)
      .transform(normalizeText)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    recipientGender: z.enum(['male', 'female']),
    recipientEmail: emailSchema,
    recipientPhone: phoneSchema,
    whisperType: z.enum([
      'congratulations',
      'comfort',
      'motivation',
      'forgiveness',
      'apology',
      'reconnection',
      'encouragement',
    ]),
    wrapStyle: z.enum([
      'gentle',
      'prophetic',
      'elegant',
      'celebration',
      'healing',
      'reconciliation',
      'gratitude',
      'romantic',
      'encouragement',
      'legacy',
    ]),
    deliveryFormat: z.enum(['text', 'audio', 'text_audio']),
    senderIntent: z.string().trim().min(5).max(600),
    senderName: z.string().trim().min(1).max(80).optional(),
  })
  .refine(data => !!data.recipientEmail || !!data.recipientPhone, {
    message: 'Recipient email or phone is required',
    path: ['recipientEmail'],
  });

const generatedContentSchema = z.object({
  title: z.string().trim().min(5).max(90),
  message: z.string().trim().min(20).max(1600),
  scriptureReference: z.string().trim().min(3).max(80),
  scriptureText: z.string().trim().min(5).max(500),
  shortPrayer: z.string().trim().min(5).max(500),
});

const updateContentSchema = z.object({ generatedContent: generatedContentSchema });
const whisperIdSchema = z.object({ whisperId: z.string().trim().min(5).max(128) });
const tokenParamSchema = z.object({ token: z.string().trim().min(32).max(256) });
const smsConsentSchema = z.object({
  phoneNumber: z.string().trim().min(8).max(25),
  smsConsent: z.boolean(),
  // Accepted for backwards-compatible clients, but never treated as evidence.
  disclosureVersion: z.string().trim().max(40).optional(),
  termsVersion: z.string().trim().max(40).optional(),
  privacyVersion: z.string().trim().max(40).optional(),
});

const uploadSchema = z.object({
  whisperId: z.string().trim().min(5).max(128),
  contentType: z.enum([
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/aac',
    'audio/wav',
    'audio/webm',
    'audio/ogg',
  ]),
});


function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeRecipientAddressName(
  recipientAddressName: string | undefined | null,
  recipientName: string,
): string {
  return normalizeText(recipientAddressName || recipientName);
}

function normalizeRecipientGender(recipientGender: unknown): RecipientGender {
  return recipientGender === 'female' ? 'female' : 'male';
}

function withWhisperFallbacks(whisper: WhisperRecord): WhisperRecord {
  return {
    ...whisper,
    recipientAddressName: normalizeRecipientAddressName(
      whisper.recipientAddressName,
      whisper.recipientName,
    ),
    recipientGender: normalizeRecipientGender(whisper.recipientGender),
  };
}

function validationError(res: Response, err: z.ZodError) {
  return res.status(400).json({
    error: 'Validation failed',
    message: 'Please check the highlighted fields and try again.',
    details: err.flatten(),
  });
}

function errorPayload(error: string, message = error, code?: string) {
  return { error, message, ...(code ? { code } : {}) };
}

function senderName(req: Request, fallback?: string): string {
  return req.user?.name?.trim() || req.user?.email?.trim() || fallback?.trim() || 'A friend';
}

async function loadOwnedWhisper(whisperId: string, uid?: string) {
  const docRef = getFirestore().collection('whispers').doc(whisperId);
  const snapshot = await docRef.get();
  const rawWhisper = snapshot.data() as WhisperRecord | undefined;

  if (!rawWhisper) return { status: 404 as const, error: 'Whisper not found' };
  const whisper = withWhisperFallbacks(rawWhisper);
  if (whisper.userId !== uid) return { status: 403 as const, error: 'Forbidden' };

  return { status: 200 as const, docRef, whisper };
}

async function recordRecipientEvent(
  whisperId: string,
  event: WhisperStatus,
  metadata?: Record<string, unknown>,
) {
  await getFirestore().collection('recipientEvents').add({
    whisperId,
    event,
    ...(metadata ? { metadata } : {}),
    createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
  });
}

function serializeWhisper(whisperId: string, whisper: WhisperRecord) {
  return {
    whisperId,
    recipientName: whisper.recipientName,
    recipientAddressName: whisper.recipientAddressName,
    recipientGender: whisper.recipientGender,
    recipientEmail: whisper.recipientEmail ?? null,
    recipientPhone: whisper.recipientPhone ?? null,
    whisperType: whisper.whisperType,
    wrapStyle: whisper.wrapStyle,
    wrap_style: whisper.wrapStyle,
    deliveryFormat: whisper.deliveryFormat,
    senderIntent: whisper.senderIntent,
    generatedContent: whisper.generatedContent,
    audioPath: whisper.audioPath ?? null,
    status: whisper.status,
  };
}

async function createAudioReadUrl(audioPath?: string | null): Promise<string | null> {
  if (!audioPath) return null;
  if (/^https?:\/\//i.test(audioPath)) return audioPath;

  const [url] = await getStorageBucket().file(audioPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 60 * 60 * 1000,
  });

  return url;
}

export async function sendWhisperSmsIfAllowed(
  docRef: FirebaseFirestore.DocumentReference,
  whisper: WhisperRecord,
  secureWhisperToken?: string,
): Promise<null | Awaited<ReturnType<typeof sendWhisperSms>>> {
  if (whisper.deliveryFormat !== 'text' && whisper.deliveryFormat !== 'text_audio') return null;
  if (whisper.smsConsent?.status !== 'granted' || !whisper.smsConsent.consentedAt) {
    console.warn({ event: 'sms.delivery.blocked', reason: 'missing_consent', whisperId: docRef.id });
    throw new SmsValidationError('Recipient SMS consent is required before sending SMS', 'sms_consent_required');
  }
  if (whisper.smsSentAt || whisper.smsDeliveryState === 'sent') return null;
  if (whisper.smsDeliveryState !== 'sending') {
    throw new SmsValidationError('SMS delivery was not atomically authorized', 'sms_delivery_not_authorized');
  }
  if (!whisper.recipientPhone) throw new SmsValidationError('Recipient phone is required', 'recipient_phone_required');
  const normalizedRecipientPhone = normalizePhoneForSms(whisper.recipientPhone);
  if (!whisper.smsConsent.phoneNumber || normalizePhoneForSms(whisper.smsConsent.phoneNumber) !== normalizedRecipientPhone) {
    throw new SmsValidationError('Consent destination does not match recipient phone', 'recipient_phone_mismatch');
  }
  if (!whisper.tokenHash) throw new SmsValidationError('Whisper access token is required', 'unwrap_token_required');
  const suppression = await getFirestore().collection('smsSuppressions').doc(phoneHash(normalizedRecipientPhone)).get();
  if (suppression.exists) {
    console.warn({ event: 'sms.delivery.blocked', reason: 'suppressed', whisperId: docRef.id });
    throw new SmsValidationError('SMS recipient is suppressed', 'sms_recipient_suppressed');
  }

  console.info({ event: 'sms.delivery.attempted', whisperId: docRef.id, phoneLast4: whisper.recipientPhone.slice(-4) });
  if (!secureWhisperToken || tokenService.hashToken(secureWhisperToken) !== whisper.tokenHash) {
    throw new SmsValidationError('Whisper access token is unavailable', 'unwrap_token_unavailable');
  }
  const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) throw new Error('Missing APP_BASE_URL');
  const smsResult = await sendWhisperSms({
    recipientPhone: normalizedRecipientPhone,
    whisper: whisper.generatedContent,
    unwrapUrl: `${baseUrl}/unwrap/${secureWhisperToken}`,
  });

  await docRef.update({
    smsSid: smsResult.sid,
    smsStatus: smsResult.status,
    smsSentAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    smsDeliveryState: 'sent',
    status: 'delivered',
    updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
  });

  await recordRecipientEvent(docRef.id, 'delivered', { smsStatus: smsResult.status });
  console.info({ event: 'sms.delivery.succeeded', whisperId: docRef.id, phoneLast4: whisper.recipientPhone.slice(-4) });

  return smsResult;
}

function logSmsError(context: string, error: unknown) {
  const twilioError = error as {
    code?: unknown;
    status?: unknown;
    moreInfo?: unknown;
  };
  console.error(context, {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : undefined,
    code: typeof twilioError?.code === 'number' ? twilioError.code : undefined,
    status: typeof twilioError?.status === 'number' ? twilioError.status : undefined,
    moreInfo: typeof twilioError?.moreInfo === 'string' ? twilioError.moreInfo : undefined,
  });
}

export async function generateWhisper(req: Request, res: Response) {
  try {
    const input = createSchema.parse(req.body);
    const normalizedRecipientPhone = input.recipientPhone
      ? normalizePhoneForSms(input.recipientPhone)
      : undefined;

    const recipientAddressName = normalizeRecipientAddressName(
      input.recipientAddressName,
      input.recipientName,
    );

    const generationInput = {
      ...input,
      recipientAddressName,
      recipientPhone: normalizedRecipientPhone,
      senderName: senderName(req),
    };

    const content = await generateWhisperContent(generationInput);

    if (!req.user?.uid) {
      return res.status(200).json({
        whisperId: null,
        persisted: false,
        recipientAddressName,
        recipientGender: input.recipientGender,
        ...content,
      });
    }

    const docRef = getFirestore().collection('whispers').doc();

    const whisper: WhisperRecord = {
      ...input,
      recipientAddressName,
      recipientGender: input.recipientGender,
      recipientEmail: input.recipientEmail ?? null,
      recipientPhone: normalizedRecipientPhone ?? null,
      senderName: generationInput.senderName,
      userId: req.user.uid,
      generatedContent: content,
      audioPath: null,
      status: 'generated',
      tokenHash: null,
      smsConsent: { status: 'pending', phoneNumber: normalizedRecipientPhone ?? null },
      smsDeliveryState: 'not_authorized',
      createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    };

    await docRef.set(whisper);

    return res.status(201).json({
      whisperId: docRef.id,
      persisted: true,
      recipientAddressName,
      recipientGender: input.recipientGender,
      ...content,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);
    if (err instanceof SmsValidationError) return res.status(400).json({ error: err.message });

    if (err instanceof GeminiGenerationError) {
      console.error('generateWhisper AI failed', {
        code: err.code,
        message: err.message,
      });

      return res
        .status(err.statusCode)
        .json(errorPayload('Failed to generate whisper', err.message, err.code));
    }

    console.error('generateWhisper failed', err);
    return res.status(500).json(errorPayload('Failed to generate whisper'));
  }
}

export async function updateWhisperContent(req: Request, res: Response) {
  try {
    const { whisperId } = whisperIdSchema.parse(req.params);
    const { generatedContent } = updateContentSchema.parse(req.body);
    const result = await loadOwnedWhisper(whisperId, req.user?.uid);

    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    if (['consent_sent', 'accepted', 'opened', 'listened'].includes(result.whisper.status)) {
      return res.status(409).json({ error: 'Cannot edit after consent has been sent' });
    }

    await result.docRef.update({
      generatedContent,
      status: 'generated',
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ whisperId, ...generatedContent });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);
    console.error('updateWhisperContent failed', err);
    return res.status(500).json({ error: 'Failed to update whisper content' });
  }
}

export async function regenerateWhisper(req: Request, res: Response) {
  try {
    const { whisperId } = whisperIdSchema.parse(req.params);
    const result = await loadOwnedWhisper(whisperId, req.user?.uid);

    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    if (['consent_sent', 'accepted', 'opened', 'listened'].includes(result.whisper.status)) {
      return res.status(409).json({ error: 'Cannot regenerate after consent has been sent' });
    }

    const content = await generateWhisperContent(result.whisper);

    await result.docRef.update({
      recipientAddressName: result.whisper.recipientAddressName,
      recipientGender: result.whisper.recipientGender,
      generatedContent: content,
      status: 'generated',
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      whisperId,
      recipientAddressName: result.whisper.recipientAddressName,
      recipientGender: result.whisper.recipientGender,
      ...content,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);

    if (err instanceof GeminiGenerationError) {
      return res
        .status(err.statusCode)
        .json(errorPayload('Failed to regenerate whisper', err.message, err.code));
    }

    console.error('regenerateWhisper failed', err);
    return res.status(500).json(errorPayload('Failed to regenerate whisper'));
  }
}

export async function confirmWhisperContent(req: Request, res: Response) {
  try {
    const { whisperId } = whisperIdSchema.parse(req.params);
    const result = await loadOwnedWhisper(whisperId, req.user?.uid);

    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    if (!result.whisper.generatedContent) {
      return res.status(409).json({ error: 'Whisper must be generated before confirmation' });
    }

    if (['consent_sent', 'accepted', 'opened', 'listened'].includes(result.whisper.status)) {
      return res.status(409).json({
        error: 'Content is already locked because consent has been sent',
      });
    }

    await result.docRef.update({
      contentConfirmedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      status: 'content_confirmed',
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true, whisperId });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);
    console.error('confirmWhisperContent failed', err);
    return res.status(500).json({ error: 'Failed to confirm whisper content' });
  }
}

export async function getWhisper(req: Request, res: Response) {
  try {
    const { whisperId } = whisperIdSchema.parse(req.params);
    const result = await loadOwnedWhisper(whisperId, req.user?.uid);

    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    return res.json(serializeWhisper(whisperId, result.whisper));
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);
    console.error('getWhisper failed', err);
    return res.status(500).json({ error: 'Failed to load whisper' });
  }
}

export async function createAudioUploadUrl(req: Request, res: Response) {
  try {
    const { whisperId, contentType } = uploadSchema.parse(req.body);
    const result = await loadOwnedWhisper(whisperId, req.user?.uid);

    if (result.status !== 200) return res.status(result.status).json({ error: result.error });

    if (result.whisper.deliveryFormat === 'text') {
      return res.status(400).json({
        error: 'Audio upload is not allowed for text-only delivery',
      });
    }

    if (['consent_sent', 'accepted', 'opened', 'listened'].includes(result.whisper.status)) {
      return res.status(409).json({ error: 'Cannot upload audio after consent has been sent' });
    }

    const extension = contentType.split('/')[1]?.replace('mpeg', 'mp3') ?? 'webm';
    const filePath = `whispers/${whisperId}/audio-${Date.now()}.${extension}`;

    const [uploadUrl] = await getStorageBucket().file(filePath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
    });

    await result.docRef.update({
      audioPath: filePath,
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      uploadUrl,
      filePath,
      expiresInSeconds: 900,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);
    console.error('createAudioUploadUrl failed', err);
    return res.status(500).json({ error: 'Failed to create upload URL' });
  }
}

export async function sendConsent(req: Request, res: Response) {
  try {
    const { whisperId } = whisperIdSchema.parse(req.body);
    const result = await loadOwnedWhisper(whisperId, req.user?.uid);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    if (!result.whisper.generatedContent) return res.status(409).json({ error: 'Whisper must be generated before sending consent' });
    const requiresAudio = ['audio', 'text_audio'].includes(result.whisper.deliveryFormat);
    if (requiresAudio && !result.whisper.audioPath) return res.status(409).json({ error: 'Audio delivery requires an uploaded audio file before consent can be sent' });
    if (['opened', 'listened'].includes(result.whisper.status)) return res.status(409).json({ error: 'Recipient has already opened this whisper' });

    const token = tokenService.generateSecureToken();
    const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, '');
    if (!baseUrl) throw new Error('Missing APP_BASE_URL');
    const consentLink = `${baseUrl}/sms-consent/${token}`;
    // "manual" means the authenticated sender copies this URL into a non-SMS
    // channel. This function must never deliver a consent invitation via Twilio.
    const channels = { email: !!result.whisper.recipientEmail, manual: !result.whisper.recipientEmail };

    await result.docRef.update({
      smsConsentTokenHash: tokenService.hashToken(token),
      smsConsentTokenCreatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      smsConsentTokenUsedAt: null,
      smsConsent: { status: 'pending', phoneNumber: result.whisper.recipientPhone ?? null },
      status: 'consent_pending',
      consentSentAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });
    if (result.whisper.recipientEmail) {
      await sendConsentEmail({
        recipientEmail: result.whisper.recipientEmail,
        recipientName: result.whisper.recipientAddressName,
        senderName: result.whisper.senderName,
        unwrapLink: consentLink,
      });
    }
    console.info({ event: 'sms.consent.link_generated', whisperId, channel: channels.email ? 'email' : 'manual' });
    await recordRecipientEvent(whisperId, 'consent_pending', { channels });
    return res.json({ success: true, consentLink, channels });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);
    console.error('sendConsent failed', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Failed to send consent' });
  }
}

function consentTokenExpired(whisper: WhisperRecord): boolean {
  const created = whisper.smsConsentTokenCreatedAt;
  if (!created || typeof (created as FirebaseFirestore.Timestamp).toMillis !== 'function') return true;
  return Date.now() - (created as FirebaseFirestore.Timestamp).toMillis() > SMS_CONSENT_TOKEN_TTL_MS;
}

async function findConsentToken(token: string) {
  const query = await getFirestore().collection('whispers')
    .where('smsConsentTokenHash', '==', tokenService.hashToken(token)).limit(2).get();
  if (query.size !== 1) return null;
  const doc = query.docs[0];
  const whisper = withWhisperFallbacks(doc.data() as WhisperRecord);
  return consentTokenExpired(whisper) && !whisper.smsConsentTokenUsedAt ? null : { doc, whisper };
}

export async function getSmsConsent(req: Request, res: Response) {
  try {
    const { token } = tokenParamSchema.parse(req.params);
    const found = await findConsentToken(token);
    if (!found) return res.status(404).json({ error: 'invalid_or_expired_consent_link' });
    const phone = found.whisper.recipientPhone;
    return res.json({
      valid: true,
      recipientName: found.whisper.recipientAddressName,
      senderName: found.whisper.senderName,
      maskedPhone: phone ? `***-***-${phone.slice(-4)}` : null,
      alreadyConsented: found.whisper.smsConsent?.status === 'granted',
      processed: !!found.whisper.smsConsentTokenUsedAt,
      consentStatus: found.whisper.smsConsent?.status ?? 'pending',
      disclosure: {
        version: SMS_DISCLOSURE_VERSION,
        text: SMS_DISCLOSURE_TEXT,
        privacyVersion: PRIVACY_POLICY_VERSION,
        termsVersion: TERMS_VERSION,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(404).json({ error: 'invalid_or_expired_consent_link' });
    console.error('getSmsConsent failed');
    return res.status(500).json({ error: 'consent_lookup_failed' });
  }
}

export async function grantSmsConsent(req: Request, res: Response) {
  try {
    const { token } = tokenParamSchema.parse(req.params);
    const input = smsConsentSchema.parse(req.body);
    const normalizedPhone = normalizePhoneForSms(input.phoneNumber);
    const found = await findConsentToken(token);
    if (!found) return res.status(404).json({ error: 'invalid_or_expired_consent_link' });
    const db = getFirestore();
    let alreadyProcessed = false;
    const secureWhisperToken = tokenService.generateSecureToken();
    const grantsConsent = input.smsConsent === true;

    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(found.doc.ref);
      const whisper = snapshot.data() as WhisperRecord | undefined;
      if (!whisper || whisper.smsConsentTokenHash !== tokenService.hashToken(token) ||
          (consentTokenExpired(whisper) && !whisper.smsConsentTokenUsedAt)) {
        throw new SmsValidationError('Invalid consent link', 'invalid_or_expired_consent_link');
      }
      if (whisper.recipientPhone && normalizePhoneForSms(whisper.recipientPhone) !== normalizedPhone) {
        throw new SmsValidationError('Recipient phone mismatch', 'recipient_phone_mismatch');
      }
      // A consent token is single-use. Replays are successful no-ops, including after
      // a provider failure, because retrying an ambiguous send could duplicate an SMS.
      if (whisper.smsConsentTokenUsedAt || whisper.smsSentAt || whisper.smsDeliveryState === 'sent' || whisper.smsDeliveryState === 'sending') {
        alreadyProcessed = true;
        return;
      }
      const now = firebaseAdmin.firestore.FieldValue.serverTimestamp();
      const status = grantsConsent ? 'granted' : 'declined';
      transaction.update(found.doc.ref, {
        recipientPhone: normalizedPhone,
        smsConsent: {
          status, phoneNumber: normalizedPhone, consentedAt: grantsConsent ? now : null,
          method: 'web-checkbox', source: SMS_CONSENT_SOURCE,
          disclosureVersion: SMS_DISCLOSURE_VERSION, disclosureText: SMS_DISCLOSURE_TEXT,
          termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_POLICY_VERSION,
        },
        tokenHash: tokenService.hashToken(secureWhisperToken),
        smsConsentTokenUsedAt: now,
        smsDeliveryState: grantsConsent && ['text', 'text_audio'].includes(whisper.deliveryFormat) ? 'sending' : 'not_authorized',
        status: grantsConsent ? 'sms_consented' : 'consent_pending',
        updatedAt: now,
      });
      transaction.create(db.collection('smsConsentEvents').doc(), {
        whisperId: found.doc.id,
        event: grantsConsent ? 'sms_consent_granted' : 'sms_consent_declined',
        phoneHash: phoneHash(normalizedPhone), phoneLast4: normalizedPhone.slice(-4),
        consentStatus: status, method: 'web-checkbox',
        disclosureVersion: SMS_DISCLOSURE_VERSION, disclosureText: SMS_DISCLOSURE_TEXT,
        termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_POLICY_VERSION,
        source: SMS_CONSENT_SOURCE, createdAt: now,
      });
    });
    if (alreadyProcessed) return res.json({ success: true, alreadyProcessed: true });

    const persisted = await found.doc.ref.get();
    const whisper = persisted.data() as WhisperRecord | undefined;
    if (!whisper) throw new Error('Persisted whisper not found');
    const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, '');
    if (!baseUrl) throw new Error('Missing APP_BASE_URL');
    const unwrapUrl = `${baseUrl}/unwrap/${secureWhisperToken}`;
    console.info({ event: grantsConsent ? 'sms.consent.granted' : 'sms.consent.declined', whisperId: found.doc.id, phoneLast4: normalizedPhone.slice(-4) });
    if (!grantsConsent || whisper.deliveryFormat === 'audio') {
      return res.json({ success: true, alreadyProcessed: false, consentStatus: grantsConsent ? 'granted' : 'declined', unwrapUrl });
    }
    try {
      await sendWhisperSmsIfAllowed(found.doc.ref, withWhisperFallbacks(whisper), secureWhisperToken);
    } catch (error) {
      await found.doc.ref.update({ smsDeliveryState: 'failed', updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
      throw error;
    }
    return res.json({ success: true, alreadyProcessed: false, consentStatus: 'granted', unwrapUrl });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (err instanceof SmsValidationError) {
      console.warn({ event: 'sms.consent.rejected', reason: err.code });
      const status = err.code === 'invalid_or_expired_consent_link' ? 404 : err.code === 'sms_recipient_suppressed' ? 403 : 400;
      return res.status(status).json({ error: err.code });
    }
    logSmsError('sms.delivery.failed', err);
    return res.status(502).json({ error: 'sms_delivery_failed' });
  }
}

export async function acceptWhisper(req: Request, res: Response) {
  try {
    const { token } = tokenParamSchema.parse(req.params);
    const db = getFirestore();
    const tokenHash = tokenService.hashToken(token);

    const query = await db.collection('whispers').where('tokenHash', '==', tokenHash).limit(1).get();
    const doc = query.docs.at(0);

    if (!doc) return res.status(404).json({ error: 'Invalid or expired link' });

    const whisper = withWhisperFallbacks(doc.data() as WhisperRecord);

    if (!['accepted', 'opened', 'listened'].includes(whisper.status)) {
      const now = firebaseAdmin.firestore.FieldValue.serverTimestamp();

      await doc.ref.update({
        status: 'accepted',
        acceptedAt: now,
        updatedAt: now,
      });

      await recordRecipientEvent(doc.id, 'accepted');
    }

    return res.json({
      success: true,
      whisperId: doc.id,
      status: 'accepted',
      wrapStyle: whisper.wrapStyle,
      wrap_style: whisper.wrapStyle,
      whisper: {
        ...whisper, status: 'accepted', wrap_style: whisper.wrapStyle,
        audioUrl: await createAudioReadUrl(whisper.audioPath),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);
    console.error('acceptWhisper failed', err);
    return res.status(500).json({ error: 'Failed to accept whisper' });
  }
}

export async function unwrapByToken(req: Request, res: Response) {
  try {
    const { token } = tokenParamSchema.parse(req.params);
    const db = getFirestore();
    const tokenHash = tokenService.hashToken(token);

    const query = await db.collection('whispers').where('tokenHash', '==', tokenHash).limit(1).get();
    const doc = query.docs.at(0);

    if (!doc) return res.status(404).json({ error: 'Invalid or expired link' });

    const whisper = withWhisperFallbacks(doc.data() as WhisperRecord);
    const now = firebaseAdmin.firestore.FieldValue.serverTimestamp();

    const firstOpen = !['accepted', 'opened', 'listened'].includes(whisper.status);
    const nextStatus = whisper.status === 'listened' ? 'listened' : 'opened';

    await doc.ref.update({
      status: nextStatus,
      ...(firstOpen ? { acceptedAt: now } : {}),
      openedAt: now,
      updatedAt: now,
    });

    if (firstOpen) await recordRecipientEvent(doc.id, 'accepted');
    await recordRecipientEvent(doc.id, 'opened');

    return res.json({
      whisperId: doc.id,
      recipientName: whisper.recipientName,
      recipientAddressName: whisper.recipientAddressName,
      recipientGender: whisper.recipientGender,
      senderName: whisper.senderName,
      deliveryFormat: whisper.deliveryFormat,
      wrapStyle: whisper.wrapStyle,
      wrap_style: whisper.wrapStyle,
      status: nextStatus,
      generatedContent: whisper.generatedContent,
      ...whisper.generatedContent,
      audioUrl: await createAudioReadUrl(whisper.audioPath),
      joinLink: process.env.WHISPERWRAP_JOIN_URL ?? null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);
    console.error('unwrapByToken failed', err);
    return res.status(500).json({ error: 'Failed to unwrap whisper' });
  }
}

export async function markListened(req: Request, res: Response) {
  try {
    const { token } = tokenParamSchema.parse(req.params);
    const db = getFirestore();
    const tokenHash = tokenService.hashToken(token);

    const query = await db.collection('whispers').where('tokenHash', '==', tokenHash).limit(1).get();
    const doc = query.docs.at(0);

    if (!doc) return res.status(404).json({ error: 'Invalid or expired link' });

    await doc.ref.update({
      status: 'listened',
      listenedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });

    await recordRecipientEvent(doc.id, 'listened');

    return res.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);
    console.error('markListened failed', err);
    return res.status(500).json({ error: 'Failed to mark audio as listened' });
  }
}
