import { Router } from 'express';
import {
  acceptWhisper,
  confirmWhisperContent,
  createAudioUploadUrl,
  generateWhisper,
  getWhisper,
  markListened,
  regenerateWhisper,
  sendConsent,
  unwrapByToken,
  updateWhisperContent,
} from '../controllers/whisper.controller.js';

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
 * Public unwrap routes
 * Keep these ABOVE /:whisperId routes.
 */
router.get('/unwrap/:token', unwrapByToken);
router.post('/unwrap/:token/accept', acceptWhisper);
router.post('/unwrap/:token/listened', markListened);

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