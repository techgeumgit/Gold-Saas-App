import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// ── Token configuration ────────────────────────────────────────────────────
const ACCESS_TOKEN_SECRET  = process.env.ACCESS_TOKEN_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
const ACCESS_TOKEN_EXPIRY  = process.env.ACCESS_TOKEN_EXPIRY  || '15m';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';

if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
  throw new Error(
    'ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be set in environment variables'
  );
}

// ── Access token ───────────────────────────────────────────────────────────

/**
 * Signs a short-lived access JWT.
 * Payload: { sub, tenantId, roleId, email }
 */
export function signAccessToken(payload) {
  return jwt.sign(payload, ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    issuer: 'goldapp',
    audience: 'goldapp-client',
  });
}

/**
 * Verifies and decodes an access JWT.
 * Throws if expired or tampered.
 */
export function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_TOKEN_SECRET, {
    issuer: 'goldapp',
    audience: 'goldapp-client',
  });
}

// ── Refresh token ──────────────────────────────────────────────────────────

/**
 * Signs a long-lived refresh JWT.
 * Payload: { sub, tenantId }
 */
export function signRefreshToken(payload) {
  return jwt.sign(payload, REFRESH_TOKEN_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
    issuer: 'goldapp',
    audience: 'goldapp-refresh',
  });
}

/**
 * Verifies and decodes a refresh JWT.
 * Throws if expired or tampered.
 */
export function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_TOKEN_SECRET, {
    issuer: 'goldapp',
    audience: 'goldapp-refresh',
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * SHA-256 hash a refresh token string before persisting to DB.
 * Keeps the database safe if it were ever compromised.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Returns milliseconds from "7d" / "15m" / "30s" style strings.
 * Used to compute expiresAt when storing RefreshToken rows.
 */
export function parseDurationMs(durationStr) {
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const match = durationStr.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid duration string: ${durationStr}`);
  return parseInt(match[1], 10) * units[match[2]];
}

export const REFRESH_TOKEN_EXPIRY_STR = REFRESH_TOKEN_EXPIRY;
