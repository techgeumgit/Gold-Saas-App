import rateLimit from 'express-rate-limit';

/**
 * authRateLimiter
 * ───────────────
 * Applies to all /api/v1/auth/* routes.
 * Allows 10 requests per IP per 15 minutes.
 *
 * TODO: Replace `windowMs`/`max` store with a RedisStore once you wire
 * up Redis — this in-memory store resets on server restart and doesn't
 * share limits across multiple Node processes.
 *
 * Example Redis upgrade:
 *   import RedisStore from 'rate-limit-redis';
 *   import { getRedisClient } from '../lib/redis.js';
 *   store: new RedisStore({ sendCommand: (...args) => getRedisClient().call(...args) })
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // limit per IP per window
  standardHeaders: true,     // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false,      // Disable the `X-RateLimit-*` headers

  message: {
    success: false,
    message: 'Too many requests from this IP. Please try again after 15 minutes.',
  },

  // Skip rate-limiting in test environments
  skip: () => process.env.NODE_ENV === 'test',
});

/**
 * refreshRateLimiter
 * ──────────────────
 * Tighter limit on the refresh endpoint to prevent token-cycling abuse.
 * Allows 30 requests per IP per 15 minutes.
 */
export const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many refresh requests. Please slow down.',
  },
  skip: () => process.env.NODE_ENV === 'test',
});
