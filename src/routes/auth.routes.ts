import { Router } from 'express';
import { forgotPassword, signUp } from '../controllers/auth.controller.js';

const router = Router();

router.post('/signup', signUp);
router.post('/forgot-password', forgotPassword);

export default router;
