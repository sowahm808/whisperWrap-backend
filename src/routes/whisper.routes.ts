import { Router } from 'express';
import { createAudioUploadUrl, generateWhisper, sendConsent, unwrapByToken } from '../controllers/whisper.controller.js';
import { requireActiveSubscription, requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/generate', requireAuth, requireActiveSubscription, generateWhisper);
router.post('/audio-upload-url', requireAuth, requireActiveSubscription, createAudioUploadUrl);
router.post('/send-consent', requireAuth, requireActiveSubscription, sendConsent);
router.get('/unwrap/:token', unwrapByToken);

export default router;
