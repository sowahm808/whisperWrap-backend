import { Request, Response } from 'express';
import { z } from 'zod';
import { sendConsentEmail } from '../services/email.service.js';
import { sendConsentSms } from '../services/sms.service.js';
import { firebaseAdmin, getFirestore, getStorageBucket } from '../services/firebase.service.js';
import { OpenAiGenerationError, generateWhisperContent } from '../services/openai.service.js';
import { tokenService } from '../services/token.service.js';
import { WhisperRecord, WhisperStatus } from '../types/whisper.types.js';

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
    recipientName: z.string().trim().min(2).max(80),
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
    ]),
    deliveryFormat: z.enum(['text', 'audio', 'text_audio']),
    senderIntent: z.string().trim().min(5).max(600),
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

function senderName(req: Request): string {
  return req.user?.name?.trim() || req.user?.email?.trim() || 'A friend';
}

async function loadOwnedWhisper(whisperId: string, uid?: string) {
  const docRef = getFirestore().collection('whispers').doc(whisperId);
  const snapshot = await docRef.get();
  const whisper = snapshot.data() as WhisperRecord | undefined;

  if (!whisper) return { status: 404 as const, error: 'Whisper not found' };
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
    recipientEmail: whisper.recipientEmail ?? null,
    recipientPhone: whisper.recipientPhone ?? null,
    whisperType: whisper.whisperType,
    wrapStyle: whisper.wrapStyle,
    deliveryFormat: whisper.deliveryFormat,
    senderIntent: whisper.senderIntent,
    generatedContent: whisper.generatedContent,
    audioPath: whisper.audioPath ?? null,
    status: whisper.status,
  };
}

async function createAudioReadUrl(audioPath?: string | null): Promise<string | null> {
  if (!audioPath) return null;

  const [url] = await getStorageBucket().file(audioPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + 60 * 60 * 1000,
  });

  return url;
}

export async function generateWhisper(req: Request, res: Response) {
  try {
    const input = createSchema.parse(req.body);
    const content = await generateWhisperContent(input);

    if (!req.user?.uid) {
      return res.status(200).json({
        whisperId: null,
        persisted: false,
        ...content,
      });
    }

    const docRef = getFirestore().collection('whispers').doc();

    const whisper: WhisperRecord = {
      ...input,
      recipientEmail: input.recipientEmail ?? null,
      recipientPhone: input.recipientPhone ?? null,
      senderName: senderName(req),
      userId: req.user.uid,
      generatedContent: content,
      audioPath: null,
      status: 'generated',
      tokenHash: null,
      createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    };

    await docRef.set(whisper);

    return res.status(201).json({
      whisperId: docRef.id,
      persisted: true,
      ...content,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);

    if (err instanceof OpenAiGenerationError) {
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
      generatedContent: content,
      status: 'generated',
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ whisperId, ...content });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);

    if (err instanceof OpenAiGenerationError) {
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

// export async function sendConsent(req: Request, res: Response) {
//   try {
//     const { whisperId } = whisperIdSchema.parse(req.body);
//     const result = await loadOwnedWhisper(whisperId, req.user?.uid);

//     if (result.status !== 200) return res.status(result.status).json({ error: result.error });

//     if (!result.whisper.generatedContent) {
//       return res.status(409).json({
//         error: 'Whisper must be generated before sending consent',
//       });
//     }

//     const requiresAudio =
//       result.whisper.deliveryFormat === 'audio' ||
//       result.whisper.deliveryFormat === 'text_audio';

//     if (requiresAudio && !result.whisper.audioPath) {
//       return res.status(409).json({
//         error: 'Audio delivery requires an uploaded audio file before consent can be sent',
//       });
//     }

//     if (['accepted', 'opened', 'listened'].includes(result.whisper.status)) {
//       return res.status(409).json({
//         error: 'Recipient has already opened this whisper',
//       });
//     }

//     if (!result.whisper.recipientEmail && !result.whisper.recipientPhone) {
//       return res.status(400).json({
//         error: 'Recipient email or phone is required to send consent',
//       });
//     }

//     const token = tokenService.generateSecureToken();
//     const tokenHash = tokenService.hashToken(token);
//     const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, '');

//     if (!baseUrl) throw new Error('Missing APP_BASE_URL');

//     const unwrapLink = `${baseUrl}/unwrap/${token}`;
//     const deliveryResults: Record<string, unknown> = {};

//     if (result.whisper.recipientEmail) {
//       deliveryResults.email = await sendConsentEmail({
//         recipientEmail: result.whisper.recipientEmail,
//         recipientName: result.whisper.recipientName,
//         senderName: result.whisper.senderName,
//         unwrapLink,
//       });
//     }

//     if (result.whisper.recipientPhone) {
//       deliveryResults.sms = await sendConsentSms({
//         recipientPhone: result.whisper.recipientPhone,
//         recipientName: result.whisper.recipientName,
//         senderName: result.whisper.senderName,
//         unwrapLink,
//       });
//     }

//     const channels = {
//       email: !!result.whisper.recipientEmail,
//       sms: !!result.whisper.recipientPhone,
//     };

//     await result.docRef.update({
//       tokenHash,
//       status: 'consent_sent',
//       consentSentAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
//       consentChannels: channels,
//       consentDelivery: deliveryResults,
//       updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
//     });

//     await recordRecipientEvent(whisperId, 'consent_sent', { channels });

//     return res.json({
//       success: true,
//       unwrapLink,
//       channels,
//     });
//   // } catch (err) {
//   //   if (err instanceof z.ZodError) return validationError(res, err);
//   //   console.error('sendConsent failed', err);
//   //   return res.status(500).json({ error: 'Failed to send consent' });
//   // }

//   } catch (err) {
//   if (err instanceof z.ZodError) return validationError(res, err);

//   console.error('sendConsent failed', err);

//   return res.status(500).json({
//     error: 'Failed to send consent',
//     message: err instanceof Error ? err.message : String(err),
//   });
// }
// }
export async function sendConsent(req: Request, res: Response) {
  try {
    const { whisperId } = whisperIdSchema.parse(req.body);
    const result = await loadOwnedWhisper(whisperId, req.user?.uid);

    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }

    if (!result.whisper.generatedContent) {
      return res.status(409).json({
        error: 'Whisper must be generated before sending consent',
      });
    }

    const requiresAudio =
      result.whisper.deliveryFormat === 'audio' ||
      result.whisper.deliveryFormat === 'text_audio';

    if (requiresAudio && !result.whisper.audioPath) {
      return res.status(409).json({
        error: 'Audio delivery requires an uploaded audio file before consent can be sent',
      });
    }

    if (['accepted', 'opened', 'listened'].includes(result.whisper.status)) {
      return res.status(409).json({
        error: 'Recipient has already opened this whisper',
      });
    }

    if (!result.whisper.recipientEmail && !result.whisper.recipientPhone) {
      return res.status(400).json({
        error: 'Recipient email or phone is required to send consent',
      });
    }

    const token = tokenService.generateSecureToken();
    const tokenHash = tokenService.hashToken(token);
    const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, '');

    if (!baseUrl) throw new Error('Missing APP_BASE_URL');

    const unwrapLink = `${baseUrl}/unwrap/${token}`;

    const deliveryResults: Record<string, unknown> = {};
    const deliveryErrors: Record<string, string> = {};

    if (result.whisper.recipientEmail) {
      try {
        deliveryResults.email = await sendConsentEmail({
          recipientEmail: result.whisper.recipientEmail,
          recipientName: result.whisper.recipientName,
          senderName: result.whisper.senderName,
          unwrapLink,
        });
      } catch (error) {
        console.error('Consent email failed', error);
        deliveryErrors.email =
          error instanceof Error ? error.message : 'Email delivery failed';
      }
    }

    if (result.whisper.recipientPhone) {
      try {
        deliveryResults.sms = await sendConsentSms({
          recipientPhone: result.whisper.recipientPhone,
          recipientName: result.whisper.recipientName,
          senderName: result.whisper.senderName,
          unwrapLink,
        });
      } catch (error) {
        console.error('Consent SMS failed', error);
        deliveryErrors.sms =
          error instanceof Error ? error.message : 'SMS delivery failed';
      }
    }

    const emailSent = !!deliveryResults.email;
    const smsSent = !!deliveryResults.sms;

    if (!emailSent && !smsSent) {
      return res.status(502).json({
        error: 'Failed to send consent',
        message: 'Consent could not be delivered by email or SMS.',
        deliveryErrors,
      });
    }

    const channels = {
      email: emailSent,
      sms: smsSent,
    };

    await result.docRef.update({
      tokenHash,
      status: 'consent_sent',
      consentSentAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      consentChannels: channels,
      consentDelivery: deliveryResults,
      consentDeliveryErrors: deliveryErrors,
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    });

    await recordRecipientEvent(whisperId, 'consent_sent', {
      channels,
      deliveryErrors,
    });

    return res.json({
      success: true,
      unwrapLink,
      channels,
      deliveryErrors,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return validationError(res, err);

    console.error('sendConsent failed', err);

    return res.status(500).json({
      error: 'Failed to send consent',
      message: err instanceof Error ? err.message : String(err),
    });
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

    const whisper = doc.data() as WhisperRecord;

    if (!['accepted', 'opened', 'listened'].includes(whisper.status)) {
      const now = firebaseAdmin.firestore.FieldValue.serverTimestamp();

      await doc.ref.update({
        status: 'accepted',
        acceptedAt: now,
        updatedAt: now,
      });

      await recordRecipientEvent(doc.id, 'accepted');
    }

    return res.json({ success: true, whisperId: doc.id });
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

    const whisper = doc.data() as WhisperRecord;
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
      senderName: whisper.senderName,
      deliveryFormat: whisper.deliveryFormat,
      generatedContent: whisper.generatedContent,
      audioUrl: await createAudioReadUrl(whisper.audioPath),
      joinLink: 'https://resurgencevibe.com',
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