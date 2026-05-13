import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  parseDurationMs,
  REFRESH_TOKEN_EXPIRY_STR,
} from '../lib/tokens.js';
import { registerSchema, loginSchema } from '../validators/auth.validator.js';

// ── Constants ──────────────────────────────────────────────────────────────
const BCRYPT_SALT_ROUNDS = 12;
const REFRESH_COOKIE_NAME = 'refreshToken';

// Cookie options shared across set / clear calls
const refreshCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',                       // cookie only sent to auth routes
  maxAge: parseDurationMs(REFRESH_TOKEN_EXPIRY_STR),
};

// ── Helper ─────────────────────────────────────────────────────────────────

/**
 * Build the access-token payload and issue both tokens.
 * Also writes a new RefreshToken row in the DB (hashed).
 */
async function issueTokens(user, { ip, deviceInfo } = {}) {
  const accessPayload = {
    sub: user.id,
    tenantId: user.tenantId,
    roleId: user.roleId,
    email: user.email,
  };

  const refreshPayload = {
    sub: user.id,
    tenantId: user.tenantId,
  };

  const accessToken  = signAccessToken(accessPayload);
  const refreshToken = signRefreshToken(refreshPayload);

  // Store SHA-256 hash of the refresh token — raw token never touches the DB
  await prisma.refreshToken.create({
    data: {
      userId:     user.id,
      tenantId:   user.tenantId,
      token:      hashToken(refreshToken),
      deviceInfo: deviceInfo ?? null,
      ipAddress:  ip ?? null,
      expiresAt:  new Date(Date.now() + parseDurationMs(REFRESH_TOKEN_EXPIRY_STR)),
    },
  });

  return { accessToken, refreshToken };
}

// ── Controllers ────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/register
 * Creates a new Tenant + Owner Role + Owner User, returns tokens.
 */
export async function register(req, res) {
  // 1. Validate request body
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { tenantName, tenantSlug, name, email, phone, password } = parsed.data;

  try {
    // 2. Check slug uniqueness before entering transaction
    const existingTenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });
    if (existingTenant) {
      return res.status(409).json({
        success: false,
        message: `Tenant slug "${tenantSlug}" is already taken`,
      });
    }

    // 3. Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // 4. Transactionally create Tenant → Owner Role → Owner User
    const user = await prisma.$transaction(async (tx) => {
      // Create tenant
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          slug: tenantSlug,
          plan: 'TRIAL',
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14-day trial
        },
      });

      // Seed a system Owner role with full permissions
      const ownerRole = await tx.role.create({
        data: {
          tenantId: tenant.id,
          name: 'Owner',
          isSystem: true,
          isDefault: false,
          permissions: {
            canSell: true,
            canEditInventory: true,
            canManageUsers: true,
            canViewReports: true,
            canManageBilling: true,
          },
        },
      });

      // Create owner user
      const newUser = await tx.user.create({
        data: {
          tenantId: tenant.id,
          roleId: ownerRole.id,
          name,
          email,
          phone,
          passwordHash,
          isActive: true,
        },
      });

      return newUser;
    });

    // 5. Issue tokens
    const { accessToken, refreshToken } = await issueTokens(user, {
      ip: req.ip,
      deviceInfo: req.headers['user-agent'],
    });

    // 6. Set httpOnly refresh cookie
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: {
        accessToken,
        user: {
          id:       user.id,
          name:     user.name,
          email:    user.email,
          tenantId: user.tenantId,
          roleId:   user.roleId,
        },
      },
    });
  } catch (err) {
    console.error('[Register] Error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * POST /api/v1/auth/login
 * Verifies credentials and issues a fresh token pair.
 */
export async function login(req, res) {
  // 1. Validate
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { email, password, tenantSlug } = parsed.data;

  try {
    // 2. Resolve tenant
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    if (!tenant || !tenant.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',          // intentionally vague
      });
    }

    // 3. Find user within that tenant
    const user = await prisma.user.findUnique({
      where: {
        email_tenantId: { email, tenantId: tenant.id },
      },
      include: { role: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // 4. Constant-time password comparison (bcrypt handles timing-safe compare)
    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // 5. Issue tokens + update lastLoginAt
    const [{ accessToken, refreshToken }] = await Promise.all([
      issueTokens(user, { ip: req.ip, deviceInfo: req.headers['user-agent'] }),
      prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
    ]);

    // 6. Set httpOnly refresh cookie
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);

    return res.status(200).json({
      success: true,
      message: 'Logged in successfully',
      data: {
        accessToken,
        user: {
          id:          user.id,
          name:        user.name,
          email:       user.email,
          tenantId:    user.tenantId,
          roleId:      user.roleId,
          permissions: user.role.permissions,
        },
      },
    });
  } catch (err) {
    console.error('[Login] Error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * POST /api/v1/auth/refresh
 * Reads httpOnly cookie, verifies refresh token, rotates tokens.
 *
 * Implements refresh token rotation: the old DB row is deleted and a new
 * one is inserted. If the same token is reused (replay attack), it's already
 * gone from the DB so verification fails.
 */
export async function refresh(req, res) {
  const incomingToken = req.cookies?.[REFRESH_COOKIE_NAME];

  if (!incomingToken) {
    return res.status(401).json({ success: false, message: 'No refresh token' });
  }

  try {
    // 1. Verify JWT signature / expiry
    const decoded = verifyRefreshToken(incomingToken);

    // 2. Check DB — must exist and not be expired
    const hashedToken = hashToken(incomingToken);
    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: hashedToken },
      include: { user: { include: { role: true } } },
    });

    if (!storedToken || storedToken.expiresAt < new Date()) {
      // Token not found or already expired — clear cookie defensively
      res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
      return res.status(401).json({ success: false, message: 'Refresh token invalid or expired' });
    }

    if (!storedToken.user.isActive) {
      return res.status(403).json({ success: false, message: 'Account is inactive' });
    }

    // 3. Rotate — delete old, issue new (atomic-ish in Prisma transaction)
    await prisma.refreshToken.delete({ where: { id: storedToken.id } });

    const { accessToken, refreshToken: newRefreshToken } = await issueTokens(storedToken.user, {
      ip: req.ip,
      deviceInfo: req.headers['user-agent'],
    });

    res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, refreshCookieOptions);

    return res.status(200).json({
      success: true,
      data: { accessToken },
    });
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
    const isExpired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      message: isExpired ? 'Refresh token expired' : 'Invalid refresh token',
    });
  }
}

/**
 * POST /api/v1/auth/logout
 * Deletes the refresh token row from DB and clears the cookie.
 * If the cookie is missing, still returns 200 (idempotent).
 */
export async function logout(req, res) {
  const incomingToken = req.cookies?.[REFRESH_COOKIE_NAME];

  if (incomingToken) {
    try {
      const hashedToken = hashToken(incomingToken);
      await prisma.refreshToken.deleteMany({
        where: { token: hashedToken },
      });
    } catch (err) {
      // Log but don't block the logout response
      console.error('[Logout] Failed to delete refresh token from DB:', err.message);
    }
  }

  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
  return res.status(200).json({ success: true, message: 'Logged out successfully' });
}
