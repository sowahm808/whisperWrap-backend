import { Request, Response } from 'express';
import { z } from 'zod';
import { sendConsentEmail } from '../services/email.service.js';
import { getFirestore, firebaseAdmin, getStorageBucket } from '../services/firebase.service.js';
import { generateWhisperContent } from '../services/openai.service.js';
import { tokenService } from '../services/token.service.js';

const createSchema = z.object({
  recipientName: z.string().min(2),
  recipientEmail: z.string().email(),
  recipientPhone: z.string().optional(),
  whisperType: z.enum(['congratulations', 'comfort', 'motivation', 'forgiveness', 'apology', 'reconnection', 'encouragement']),
  wrapStyle: z.enum(['gentle', 'prophetic', 'elegant', 'celebration', 'healing', 'reconciliation']),
  deliveryFormat: z.enum(['text', 'audio', 'text_audio']),
  senderIntent: z.string().min(5).max(400),
});

const sendConsentSchema = z.object({ whisperId: z.string().min(5) });
const uploadSchema = z.object({ whisperId: z.string().min(5), contentType: z.string().startsWith('audio/') });

export async function generateWhisper(req: Request, res: Response) { /* unchanged */
  try {
    const input = createSchema.parse(req.body);
    const content = await generateWhisperContent(input);
    const db = getFirestore();
    const docRef = db.collection('whispers').doc();
    await docRef.set({ ...input, senderName: req.user?.email ?? 'A friend', userId: req.user?.uid, generatedContent: content, status: 'generated', createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(), updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
    return res.status(201).json({ whisperId: docRef.id, ...content });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.flatten() });
    return res.status(500).json({ error: 'Failed to generate whisper' });
  }
}

export async function createAudioUploadUrl(req: Request, res: Response) {
  try {
    const { whisperId, contentType } = uploadSchema.parse(req.body);
    const db = getFirestore();
    const docRef = db.collection('whispers').doc(whisperId);
    const whisper = (await docRef.get()).data();
    if (!whisper) return res.status(404).json({ error: 'Whisper not found' });
    if (whisper.userId !== req.user?.uid) return res.status(403).json({ error: 'Forbidden' });

    const filePath = `whispers/${whisperId}/audio-${Date.now()}.webm`;
    const [uploadUrl] = await getStorageBucket().file(filePath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
    });

    await docRef.update({ audioPath: filePath, updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
    return res.json({ uploadUrl, filePath });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.flatten() });
    return res.status(500).json({ error: 'Failed to create upload URL' });
  }
}

export async function sendConsent(req: Request, res: Response) { try {
  const { whisperId } = sendConsentSchema.parse(req.body); const db = getFirestore(); const docRef = db.collection('whispers').doc(whisperId); const snapshot = await docRef.get();
  if (!snapshot.exists) return res.status(404).json({ error: 'Whisper not found' }); const whisper = snapshot.data(); if (whisper?.userId !== req.user?.uid) return res.status(403).json({ error: 'Forbidden' });
  const token = tokenService.generateSecureToken(); const baseUrl = process.env.APP_BASE_URL; if (!baseUrl) throw new Error('Missing APP_BASE_URL'); const unwrapLink = `${baseUrl}/unwrap/${token}`;
  await sendConsentEmail({ recipientEmail: whisper.recipientEmail, senderName: whisper.senderName, unwrapLink });
  await docRef.update({ token, status: 'consent_sent', updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
  await db.collection('recipientEvents').add({ whisperId, event: 'consent_sent', createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
  return res.json({ success: true, unwrapLink });
} catch (err) { if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.flatten() }); return res.status(500).json({ error: 'Failed to send consent' }); } }

export async function unwrapByToken(req: Request, res: Response) { try {
  const { token } = z.object({ token: z.string().min(16) }).parse(req.params); const db = getFirestore(); const query = await db.collection('whispers').where('token', '==', token).limit(1).get();
  if (query.empty) return res.status(404).json({ error: 'Invalid link' }); const doc = query.docs[0]; const whisper = doc.data();
  await doc.ref.update({ status: 'opened', updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
  await db.collection('recipientEvents').add({ whisperId: doc.id, event: 'opened', createdAt: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
  return res.json({ whisperId: doc.id, recipientName: whisper.recipientName, deliveryFormat: whisper.deliveryFormat, generatedContent: whisper.generatedContent, audioPath: whisper.audioPath ?? null, joinLink: 'https://resurgencevibe.com' });
} catch { return res.status(500).json({ error: 'Failed to unwrap whisper' }); } }
