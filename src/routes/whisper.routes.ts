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
import { requireActiveSubscription, requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/generate', requireAuth, requireActiveSubscription, generateWhisper);
router.get('/:whisperId', requireAuth, requireActiveSubscription, getWhisper);
router.patch('/:whisperId/content', requireAuth, requireActiveSubscription, updateWhisperContent);
router.post('/:whisperId/regenerate', requireAuth, requireActiveSubscription, regenerateWhisper);
router.post('/:whisperId/confirm', requireAuth, requireActiveSubscription, confirmWhisperContent);
router.post('/audio-upload-url', requireAuth, requireActiveSubscription, createAudioUploadUrl);
router.post('/send-consent', requireAuth, requireActiveSubscription, sendConsent);
router.post('/unwrap/:token/accept', acceptWhisper);
router.get('/unwrap/:token', unwrapByToken);
router.post('/unwrap/:token/listened', markListened);

export default router;
