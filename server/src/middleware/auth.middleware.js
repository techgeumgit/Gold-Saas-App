import { verifyAccessToken } from '../lib/tokens.js';

/**
 * authenticate
 * ────────────
 * Reads `Authorization: Bearer <token>` header, verifies the JWT,
 * and attaches the decoded payload to `req.user`.
 *
 * Protected routes should apply this middleware before their handler.
 */
export function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No access token provided',
      });
    }

    const token = authHeader.slice(7); // strip "Bearer "
    const decoded = verifyAccessToken(token);

    req.user = {
      id: decoded.sub,
      tenantId: decoded.tenantId,
      roleId: decoded.roleId,
      email: decoded.email,
    };

    next();
  } catch (err) {
    const isExpired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      message: isExpired ? 'Access token expired' : 'Invalid access token',
    });
  }
}

/**
 * scopeTenant
 * ───────────
 * Extracts `tenantId` from the verified JWT payload and attaches it
 * to `req.tenantId` for easy access in route handlers.
 *
 * Must be used AFTER `authenticate`.
 */
export function scopeTenant(req, res, next) {
  if (!req.user?.tenantId) {
    return res.status(403).json({
      success: false,
      message: 'Tenant context missing from token',
    });
  }

  req.tenantId = req.user.tenantId;
  next();
}
