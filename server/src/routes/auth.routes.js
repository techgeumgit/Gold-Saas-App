import { Router } from 'express';
import { register, login, refresh, logout } from '../controllers/auth.controller.js';
import { authRateLimiter, refreshRateLimiter } from '../middleware/rateLimiter.middleware.js';

const router = Router();

/**
 * POST /api/v1/auth/register
 * Create tenant + owner user, hash password, return tokens
 */
router.post('/register', authRateLimiter, register);

/**
 * POST /api/v1/auth/login
 * Verify credentials, issue access JWT + set refresh token in httpOnly cookie
 */
router.post('/login', authRateLimiter, login);

/**
 * POST /api/v1/auth/refresh
 * Read httpOnly cookie, verify refresh token, rotate + issue new access token
 */
router.post('/refresh', refreshRateLimiter, refresh);

/**
 * POST /api/v1/auth/logout
 * Clear the httpOnly refresh token cookie + delete DB row (idempotent)
 */
router.post('/logout', logout);

export default router;
