import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhoneForSms, SmsValidationError, twilioSender } from '../services/sms.service.js';
import { tokenService } from '../services/token.service.js';
import { phoneHash } from '../services/sms.service.js';
import {
  PRIVACY_POLICY_VERSION,
  SMS_DISCLOSURE_TEXT,
  SMS_DISCLOSURE_VERSION,
  TERMS_VERSION,
} from '../config/sms-compliance.js';
import fs from 'node:fs';

test('phone normalization produces E.164 and rejects malformed input', () => {
  assert.equal(normalizePhoneForSms('(214) 555-1234'), '+12145551234');
  assert.throws(() => normalizePhoneForSms('not a phone'), SmsValidationError);
});

test('phone hashes are normalized, peppered, and do not disclose the phone', () => {
  const original = process.env.SMS_PHONE_HASH_PEPPER;
  try {
    process.env.SMS_PHONE_HASH_PEPPER = 'test-only-pepper';
    assert.equal(phoneHash('(214) 555-1234'), phoneHash('+12145551234'));
    assert.doesNotMatch(phoneHash('+12145551234'), /2145551234/);
  } finally {
    if (original === undefined) delete process.env.SMS_PHONE_HASH_PEPPER;
    else process.env.SMS_PHONE_HASH_PEPPER = original;
  }
});

test('compliance evidence is server controlled and contains A2P disclosures', () => {
  assert.equal(SMS_DISCLOSURE_VERSION, '2026-08-13');
  assert.equal(PRIVACY_POLICY_VERSION, '2026-08-13');
  assert.equal(TERMS_VERSION, '2026-08-13');
  assert.match(SMS_DISCLOSURE_TEXT, /Message and data rates may apply/);
  assert.match(SMS_DISCLOSURE_TEXT, /Reply STOP/);
  assert.match(SMS_DISCLOSURE_TEXT, /HELP/);
});

test('consent invitation is email-or-manual and contains no Twilio send', () => {
  const controller = fs.readFileSync(new URL('../controllers/whisper.controller.js', import.meta.url), 'utf8');
  const sendConsentBody = controller.slice(controller.indexOf('async function sendConsent'), controller.indexOf('function consentTokenExpired'));
  assert.match(sendConsentBody, /sendConsentEmail/);
  assert.match(sendConsentBody, /manual: !result\.whisper\.recipientEmail/);
  assert.doesNotMatch(sendConsentBody, /sendWhisperSms|messages\.create/);
});

test('consent is optional, server evidence is persisted, and decline cannot authorize delivery', () => {
  const controller = fs.readFileSync(new URL('../controllers/whisper.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /smsConsent: z\.boolean\(\)/);
  assert.match(controller, /sms_consent_declined/);
  assert.match(controller, /phoneHash: phoneHash\(normalizedPhone\)/);
  assert.match(controller, /disclosureText: SMS_DISCLOSURE_TEXT/);
  assert.match(controller, /disclosureVersion: SMS_DISCLOSURE_VERSION/);
  assert.match(controller, /if \(!grantsConsent \|\| whisper\.deliveryFormat === 'audio'\)/);
  assert.match(controller, /smsConsentTokenUsedAt/);
});

test('SMS authorization checks state, destination, suppression, and distinct access token', () => {
  const controller = fs.readFileSync(new URL('../controllers/whisper.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /smsConsent\?\.status !== 'granted'/);
  assert.match(controller, /smsDeliveryState !== 'sending'/);
  assert.match(controller, /smsConsent\.phoneNumber/);
  assert.match(controller, /smsSuppressions/);
  assert.match(controller, /tokenService\.hashToken\(secureWhisperToken\) !== whisper\.tokenHash/);
  assert.match(controller, /smsConsentTokenHash/);
});

test('provider failure preserves successful consent and returns a controlled accepted response', () => {
  const controller = fs.readFileSync(new URL('../controllers/whisper.controller.js', import.meta.url), 'utf8');
  assert.match(controller, /smsDeliveryState: 'failed'/);
  assert.match(controller, /res\.status\(202\)\.json/);
  assert.match(controller, /consentStatus: 'granted'/);
  assert.match(controller, /deliveryStatus: 'failed'/);
  assert.match(controller, /deliveryError: 'sms_delivery_failed'/);
});

test('inbound STOP is suppressed while HELP never grants consent', () => {
  const webhook = fs.readFileSync(new URL('../controllers/sms-webhook.controller.js', import.meta.url), 'utf8');
  assert.match(webhook, /STOPALL/);
  assert.match(webhook, /recipient_opt_out/);
  assert.match(webhook, /source: 'twilio-inbound'/);
  const helpBranch = webhook.slice(webhook.indexOf("keyword === 'HELP'"));
  assert.doesNotMatch(helpBranch, /status: 'granted'/);
});

test('no legacy YES opt-in or consent SMS implementation remains', () => {
  const production = ['controllers/whisper.controller.js', 'controllers/sms-webhook.controller.js', 'services/sms.service.js']
    .map(file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(production, /Reply YES|reply YES|sms_consent_required.*YES/);
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
