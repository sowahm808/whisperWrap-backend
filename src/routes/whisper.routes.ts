import { Router } from 'express';
import {
  acceptWhisper,
  confirmWhisperContent,
  createAudioUploadUrl,
  generateWhisper,
  getSmsConsent,
  getWhisper,
  grantSmsConsent,
  markListened,
  regenerateWhisper,
  sendConsent,
  unwrapByToken,
  updateWhisperContent,
} from '../controllers/whisper.controller.js';
import { consentRateLimit } from '../middleware/rate-limit.middleware.js';

import {
  allowPublicGeneration,
  requireActiveSubscription,
  requireActiveSubscriptionForAuthenticatedUser,
  requireAuth,
} from '../middleware/auth.middleware.js';

const router = Router();

/**
 * Generate whisper
 * Public generation is allowed, but authenticated users still need
 * active subscription validation when applicable.
 */
router.post(
  '/generate',
  allowPublicGeneration,
  requireActiveSubscriptionForAuthenticatedUser,
  generateWhisper
);

/**
 * Authenticated fixed routes
 */
router.post(
  '/audio-upload-url',
  requireAuth,
  requireActiveSubscription,
  createAudioUploadUrl
);

router.post(
  '/send-consent',
  requireAuth,
  requireActiveSubscription,
  sendConsent
);

/**
 * Recipient consent routes are intentionally public. Keep them before the
 * authenticated /:whisperId routes so consent links never require Firebase
 * authentication or get interpreted as whisper IDs.
 */
router.get('/sms-consent/:token', consentRateLimit, getSmsConsent);
router.post('/sms-consent/:token', consentRateLimit, grantSmsConsent);

/**
 * Public unwrap routes
 * Keep these ABOVE /:whisperId routes.
 */
router.get('/unwrap/:token', unwrapByToken);
router.post('/unwrap/:token/accept', acceptWhisper);
router.post('/unwrap/:token/listened', markListened);

/**
 * Authenticated dynamic whisper routes
 * Keep these LAST so they do not catch /unwrap or fixed paths.
 */
router.get(
  '/:whisperId',
  requireAuth,
  requireActiveSubscription,
  getWhisper
);

router.patch(
  '/:whisperId/content',
  requireAuth,
  requireActiveSubscription,
  updateWhisperContent
);

router.post(
  '/:whisperId/regenerate',
  requireAuth,
  requireActiveSubscription,
  regenerateWhisper
);

router.post(
  '/:whisperId/confirm',
  requireAuth,
  requireActiveSubscription,
  confirmWhisperContent
);

export default router;
