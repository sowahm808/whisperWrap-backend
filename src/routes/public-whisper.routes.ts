import { Router } from 'express';
import { getSmsConsent, grantSmsConsent } from '../controllers/whisper.controller.js';
import { consentRateLimit } from '../middleware/rate-limit.middleware.js';

const router = Router();
router.get('/:token/sms-consent', consentRateLimit, getSmsConsent);
router.post('/:token/sms-consent', consentRateLimit, grantSmsConsent);
export default router;
