import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express, { type Request, type Response } from 'express';
import whisperRouter from '../routes/whisper.routes.js';
import { consentTokenExpired, findConsentToken } from '../controllers/whisper.controller.js';
import { SMS_CONSENT_TOKEN_TTL_MS, tokenService } from '../services/token.service.js';
import type { WhisperRecord } from '../types/whisper.types.js';

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
  };
};

function timestamp(milliseconds: number) {
  return { toMillis: () => milliseconds } as FirebaseFirestore.Timestamp;
}

function whisper(createdAt: FirebaseFirestore.Timestamp): WhisperRecord {
  return {
    userId: 'sender-id', senderName: 'Sender', recipientName: 'Recipient',
    recipientAddressName: 'Recipient', recipientGender: 'female', recipientEmail: null,
    recipientPhone: '+12145556649', whisperType: 'encouragement', wrapStyle: 'gentle',
    deliveryFormat: 'audio', senderIntent: 'A test whisper intent',
    generatedContent: { title: 'A title', message: 'A sufficiently long test message', scriptureReference: 'John 1:1', scriptureText: 'Test scripture', shortPrayer: 'Test prayer' },
    status: 'consent_pending', smsConsentTokenCreatedAt: createdAt,
    createdAt: {} as FirebaseFirestore.FieldValue, updatedAt: {} as FirebaseFirestore.FieldValue,
  };
}

test('consent lookup uses the stored SHA-256 hash and accepts a current Firestore Timestamp', async () => {
  const token = 'a'.repeat(43);
  const record = whisper(timestamp(Date.now() - 1_000));
  const doc = { data: () => record };
  let queriedHash = '';
  const db = {
    collection: () => ({
      where: (_field: string, _operator: string, value: string) => {
        queriedHash = value;
        return { limit: () => ({ get: async () => ({ size: 1, docs: [doc] }) }) };
      },
    }),
  } as unknown as FirebaseFirestore.Firestore;

  const found = await findConsentToken(token, db);
  assert.equal(queriedHash, tokenService.hashToken(token));
  assert.equal(found?.whisper.recipientAddressName, 'Recipient');
  assert.equal(consentTokenExpired(record), false);
  assert.equal(consentTokenExpired(whisper(timestamp(Date.now() - SMS_CONSENT_TOKEN_TTL_MS - 1))), true);
});

test('recipient consent routes are public, ordered before generic routes, and preserve controlled responses', async () => {
  const layers = (whisperRouter as unknown as { stack: RouterLayer[] }).stack.filter(layer => layer.route);
  const getIndex = layers.findIndex(layer => layer.route?.path === '/sms-consent/:token' && layer.route.methods.get);
  const postIndex = layers.findIndex(layer => layer.route?.path === '/sms-consent/:token' && layer.route.methods.post);
  const genericIndex = layers.findIndex(layer => layer.route?.path === '/:whisperId' && layer.route.methods.get);
  assert.ok(getIndex >= 0 && postIndex >= 0, 'GET and POST consent routes must be registered');
  assert.ok(getIndex < genericIndex && postIndex < genericIndex, 'specific consent routes must precede /:whisperId');

  for (const index of [getIndex, postIndex]) {
    const names = layers[index].route!.stack.map(item => item.handle.name);
    assert.ok(!names.includes('requireAuth'), 'recipient consent route must be public');
  }
  const senderLayer = layers.find(layer => layer.route?.path === '/send-consent');
  assert.ok(senderLayer?.route?.stack.some(item => item.handle.name === 'requireAuth'));

  // Replace only the terminal controllers so this remains an HTTP integration
  // test of the production router's mount paths, middleware, and ordering.
  const originals = [layers[getIndex].route!.stack.at(-1)!.handle, layers[postIndex].route!.stack.at(-1)!.handle];
  const response = (req: Request, res: Response) => {
    if (req.params.token === 'valid-token'.padEnd(32, 'x')) {
      return res.json({ valid: true, recipientName: 'Recipient', senderName: 'Sender', maskedPhone: '***-***-6649', alreadyConsented: false });
    }
    return res.status(404).json({ error: 'invalid_or_expired_consent_link' });
  };
  layers[getIndex].route!.stack.at(-1)!.handle = response;
  layers[postIndex].route!.stack.at(-1)!.handle = response;

  const app = express();
  app.use(express.json());
  app.use('/api/whispers', whisperRouter);
  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const validToken = 'valid-token'.padEnd(32, 'x');
    const validGet = await fetch(`${base}/api/whispers/sms-consent/${validToken}`);
    assert.equal(validGet.status, 200);
    assert.equal((await validGet.json() as { maskedPhone: string }).maskedPhone, '***-***-6649');
    const validPost = await fetch(`${base}/api/whispers/sms-consent/${validToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(validPost.status, 200);
    for (const token of ['invalid-token'.padEnd(32, 'x'), 'expired-token'.padEnd(32, 'x')]) {
      const result = await fetch(`${base}/api/whispers/sms-consent/${token}`);
      assert.equal(result.status, 404);
      assert.deepEqual(await result.json(), { error: 'invalid_or_expired_consent_link' });
    }
    const sender = await fetch(`${base}/api/whispers/send-consent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(sender.status, 401);
  } finally {
    layers[getIndex].route!.stack.at(-1)!.handle = originals[0];
    layers[postIndex].route!.stack.at(-1)!.handle = originals[1];
    server.close();
    await once(server, 'close');
  }
});
