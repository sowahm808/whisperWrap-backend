import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhoneForSms, SmsValidationError, twilioSender } from '../services/sms.service.js';
import { tokenService } from '../services/token.service.js';

test('phone normalization produces E.164 and rejects malformed input', () => {
  assert.equal(normalizePhoneForSms('(214) 555-1234'), '+12145551234');
  assert.throws(() => normalizePhoneForSms('not a phone'), SmsValidationError);
});

test('consent tokens are high entropy and only hashes need persistence', () => {
  const first = tokenService.generateSecureToken();
  const second = tokenService.generateSecureToken();
  assert.notEqual(first, second);
  assert.ok(first.length >= 32);
  assert.match(tokenService.hashToken(first), /^[a-f0-9]{64}$/);
  assert.notEqual(tokenService.hashToken(first), first);
});

test('Twilio sender prefers a Messaging Service and falls back to a normalized number', () => {
  const originalService = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const originalPhone = process.env.TWILIO_PHONE_NUMBER;
  try {
    process.env.TWILIO_MESSAGING_SERVICE_SID = `MG${'a'.repeat(32)}`;
    process.env.TWILIO_PHONE_NUMBER = '(214) 555-1234';
    assert.deepEqual(twilioSender(), { messagingServiceSid: `MG${'a'.repeat(32)}` });

    delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    assert.deepEqual(twilioSender(), { from: '+12145551234' });

    delete process.env.TWILIO_PHONE_NUMBER;
    assert.throws(() => twilioSender(), /set TWILIO_MESSAGING_SERVICE_SID or TWILIO_PHONE_NUMBER/);
  } finally {
    if (originalService === undefined) delete process.env.TWILIO_MESSAGING_SERVICE_SID;
    else process.env.TWILIO_MESSAGING_SERVICE_SID = originalService;
    if (originalPhone === undefined) delete process.env.TWILIO_PHONE_NUMBER;
    else process.env.TWILIO_PHONE_NUMBER = originalPhone;
  }
});
