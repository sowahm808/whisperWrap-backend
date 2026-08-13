import { Router } from 'express';
import express from 'express';
import { inboundSmsWebhook } from '../controllers/sms-webhook.controller.js';

const router = Router();
router.post('/twilio/sms', express.urlencoded({ extended: false }), inboundSmsWebhook);
export default router;
