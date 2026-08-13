import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePhoneForSms, SmsValidationError } from '../services/sms.service.js';
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
