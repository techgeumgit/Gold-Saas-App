# Gold SaaS — Backend Documentation

> **Last updated:** 2026-05-12
> This file is a living document. Append new sections here whenever a feature, route, or schema change is introduced.

---

## Table of Contents

1. [Project Structure](#project-structure)
2. [Tech Stack & Libraries](#tech-stack--libraries)
3. [Environment Variables](#environment-variables)
4. [Database Schema](#database-schema)
5. [Auth API Reference](#auth-api-reference)
6. [Middleware](#middleware)
7. [Security Design Decisions](#security-design-decisions)
8. [Changelog](#changelog)

---

## Project Structure

```
goldapp/
├── client/                        # Frontend (not documented here)
└── server/
    ├── index.js                   # Express app entry point
    ├── prisma.config.ts           # Prisma v7 config (DB URL, migration path)
    ├── prisma/
    │   ├── schema.prisma          # Data models
    │   └── migrations/            # Auto-generated SQL migration history
    ├── src/
    │   ├── lib/
    │   │   ├── prisma.js          # Singleton Prisma client
    │   │   ├── redis.js           # Lazy ioredis client (optional)
    │   │   └── tokens.js          # JWT sign/verify + SHA-256 token hashing
    │   ├── validators/
    │   │   └── auth.validator.js  # Zod schemas for register & login
    │   ├── middleware/
    │   │   ├── auth.middleware.js          # authenticate + scopeTenant
    │   │   └── rateLimiter.middleware.js   # express-rate-limit configs
    │   ├── controllers/
    │   │   └── auth.controller.js # Register, login, refresh, logout handlers
    │   └── routes/
    │       └── auth.routes.js     # Router: POST /api/v1/auth/*
    └── .env                       # Local secrets (never commit)
```

---

## Tech Stack & Libraries

| Package | Version | Role |
|---|---|---|
| **express** | ^5.2 | HTTP server & routing |
| **@prisma/client** | ^7.8 | Type-safe PostgreSQL ORM |
| **@prisma/adapter-pg** | ^7.8 | Prisma v7 driver adapter — replaces the internal Rust engine; bridges Prisma to `pg` |
| **prisma** | ^7.8 | CLI — migrations, schema generation |
| **jsonwebtoken** | ^9.0 | Sign & verify JWTs (access + refresh tokens) |
| **bcryptjs** | ^2.x | Password hashing (bcrypt, cost factor 12) |
| **cookie-parser** | ^1.4 | Parse `httpOnly` refresh token from `req.cookies` |
| **zod** | ^3.x | Runtime request body validation |
| **express-rate-limit** | ^7.x | In-process rate limiting (Redis-upgradeable) |
| **ioredis** | ^5.10 | Redis client — wired up for future Redis-backed rate limiter |
| **cors** | ^2.8 | Cross-Origin Resource Sharing (credentials mode) |
| **dotenv** | ^17 | Load `.env` into `process.env` |
| **nodemon** | ^3.1 (dev) | Auto-restart server on file changes during development |

---

## Environment Variables

All variables live in `server/.env`. **Never commit this file.**

```env
# Database
DATABASE_URL=postgresql://...        # Neon PostgreSQL connection string

# App
NODE_ENV=development
PORT=5001
CLIENT_URL=http://localhost:5173     # Allowed CORS origin

# JWT
ACCESS_TOKEN_SECRET=<64-byte hex>    # Generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
REFRESH_TOKEN_SECRET=<64-byte hex>   # Different secret from access token
ACCESS_TOKEN_EXPIRY=15m              # Short-lived — sent in response body
REFRESH_TOKEN_EXPIRY=7d              # Long-lived — stored in httpOnly cookie

# Redis (optional — rate limiter degrades gracefully to in-memory without this)
# REDIS_URL=redis://localhost:6379
```

---

## Database Schema

> Prisma schema file: `server/prisma/schema.prisma`
> Migration applied: `20260512063747_init_auth_schema`

### Tenant

The top-level isolation unit. Every user, role, and session belongs to exactly one tenant (jewellery shop).

| Column | Type | Notes |
|---|---|---|
| `id` | `String (UUID)` | PK |
| `name` | `String` | Display name, e.g. "Acme Jewels" |
| `slug` | `String (unique)` | URL/subdomain key, e.g. "acme-jewels" |
| `plan` | `Plan enum` | `TRIAL` \| `STANDARD` \| `ENTERPRISE` |
| `trialEndsAt` | `DateTime?` | Set to +14 days on register |
| `isActive` | `Boolean` | Soft-disable a tenant |
| `currency` | `String` | Default `"INR"` |
| `timezone` | `String` | Default `"Asia/Kolkata"` |

### Role

Per-tenant, dynamic roles. Each tenant gets a system **Owner** role seeded automatically on registration.

| Column | Type | Notes |
|---|---|---|
| `id` | `String (UUID)` | PK |
| `tenantId` | `String` | FK → Tenant |
| `name` | `String` | Unique per tenant |
| `permissions` | `Json` | `{ canSell, canEditInventory, canManageUsers, … }` |
| `isDefault` | `Boolean` | Auto-assigned to new users if true |
| `isSystem` | `Boolean` | `true` = undeletable (Owner role) |

**Unique constraint:** `(name, tenantId)` — "Manager" can exist in two different tenants independently.

### User

Belongs to one tenant, has one role. Email uniqueness is scoped per tenant.

| Column | Type | Notes |
|---|---|---|
| `id` | `String (UUID)` | PK |
| `tenantId` | `String` | FK → Tenant |
| `roleId` | `String` | FK → Role |
| `name` | `String` | Display name |
| `email` | `String` | Unique per tenant |
| `phone` | `String?` | Optional, validated as international format |
| `passwordHash` | `String` | bcrypt hash (cost 12) |
| `isActive` | `Boolean` | Soft-disable a user |
| `lastLoginAt` | `DateTime?` | Updated on every successful login |

**Unique constraint:** `(email, tenantId)` — same email can register across different tenants.

### RefreshToken

One row per active session. The raw token is **never** stored — only its SHA-256 hash.

| Column | Type | Notes |
|---|---|---|
| `id` | `String (UUID)` | PK |
| `tenantId` | `String` | FK → Tenant (for fast tenant-wide session wipe) |
| `userId` | `String` | FK → User |
| `token` | `String (unique)` | SHA-256(`rawRefreshToken`) |
| `deviceInfo` | `String?` | User-Agent header at login time |
| `ipAddress` | `String?` | Request IP at login time |
| `expiresAt` | `DateTime` | Hard expiry (matches JWT `REFRESH_TOKEN_EXPIRY`) |

---

## Auth API Reference

Base path: `/api/v1/auth`

All endpoints accept and return `Content-Type: application/json`.

---

### `POST /api/v1/auth/register`

**Rate limit:** 10 requests / 15 min / IP

Creates a new **Tenant** + seeds an **Owner Role** + creates the **Owner User** — all inside a single Prisma transaction. Issues an access token (response body) and a refresh token (httpOnly cookie).

**Request body:**
```json
{
  "tenantName": "Acme Jewels",
  "tenantSlug": "acme-jewels",
  "name": "Ravi Kumar",
  "email": "ravi@acmejewels.com",
  "phone": "+919876543210",
  "password": "SecurePass1"
}
```

**Validation rules (Zod):**
- `tenantSlug` — lowercase letters, numbers, hyphens only; 2–63 chars
- `password` — min 8 chars, must have uppercase, lowercase, and a digit
- `phone` — optional, must match international format

**Success `201`:**
```json
{
  "success": true,
  "message": "Account created successfully",
  "data": {
    "accessToken": "<JWT>",
    "user": { "id": "…", "name": "…", "email": "…", "tenantId": "…", "roleId": "…" }
  }
}
```

**Cookie set:** `refreshToken` (httpOnly, secure in production, `SameSite=Strict`, path `/api/v1/auth`)

---

### `POST /api/v1/auth/login`

**Rate limit:** 10 requests / 15 min / IP

Resolves the tenant by slug, then verifies the user's bcrypt password. Updates `lastLoginAt`. Issues a new token pair.

**Request body:**
```json
{
  "tenantSlug": "acme-jewels",
  "email": "ravi@acmejewels.com",
  "password": "SecurePass1"
}
```

**Success `200`:**
```json
{
  "success": true,
  "message": "Logged in successfully",
  "data": {
    "accessToken": "<JWT>",
    "user": {
      "id": "…", "name": "…", "email": "…",
      "tenantId": "…", "roleId": "…",
      "permissions": { "canSell": true, "…": "…" }
    }
  }
}
```

> All invalid-credential cases return **the same `401` message** (`"Invalid credentials"`) to prevent user enumeration.

---

### `POST /api/v1/auth/refresh`

**Rate limit:** 30 requests / 15 min / IP

Reads the `refreshToken` httpOnly cookie, verifies the JWT signature, checks the hashed token against the DB, then **rotates** the token pair (old DB row deleted, new one inserted). This prevents replay attacks — a stolen refresh token can only be used once.

**No request body needed** (reads from cookie).

**Success `200`:**
```json
{
  "success": true,
  "data": { "accessToken": "<new JWT>" }
}
```

**New `refreshToken` cookie is set automatically.**

---

### `POST /api/v1/auth/logout`

**No rate limit** (idempotent, can safely be called multiple times)

Deletes the refresh token row from the DB and clears the cookie. Returns `200` even if no cookie was present.

**No request body needed.**

**Success `200`:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

## Middleware

### `authenticate`

```js
import { authenticate } from './src/middleware/auth.middleware.js';
```

Reads `Authorization: Bearer <token>` from the request header, verifies it against `ACCESS_TOKEN_SECRET`, and attaches the decoded payload to `req.user`:

```js
req.user = { id, tenantId, roleId, email }
```

Returns `401` if the header is missing, the token is tampered, or the token is expired.

**Usage:**
```js
router.get('/protected', authenticate, myHandler);
```

---

### `scopeTenant`

```js
import { scopeTenant } from './src/middleware/auth.middleware.js';
```

Must be used **after** `authenticate`. Copies `req.user.tenantId` → `req.tenantId` for convenient access in handlers, ensuring every query is automatically scoped to the correct tenant.

**Usage:**
```js
router.get('/inventory', authenticate, scopeTenant, inventoryHandler);
// Inside handler: prisma.item.findMany({ where: { tenantId: req.tenantId } })
```

---

## Security Design Decisions

| Decision | Reason |
|---|---|
| **Refresh token stored as SHA-256 hash** | If the DB is ever leaked, raw tokens can't be replayed |
| **Refresh token rotation on every `/refresh`** | Stolen tokens can only be used once before they're invalidated |
| **httpOnly + SameSite=Strict cookie** | Refresh token is inaccessible to JS (XSS protection); cookie won't be sent cross-site (CSRF protection) |
| **Cookie path = `/api/v1/auth`** | Browser only sends the cookie to auth endpoints, not every API call |
| **Vague `"Invalid credentials"` message** | Prevents user enumeration — attacker can't distinguish wrong email from wrong password |
| **bcrypt cost factor 12** | ~300ms on modern hardware — expensive enough to slow brute force |
| **Access token short-lived (15m)** | Minimises exposure window if intercepted |
| **Tenant-scoped email uniqueness** | Same person can own/work at multiple jewellery shops |
| **Prisma transaction for register** | Tenant + Role + User are created atomically — no partial state |

---

## Changelog

### 2026-05-12 — Initial Auth System

- **Schema:** Introduced `Tenant`, `Role`, `User`, `RefreshToken` models and `Plan` enum. Migrated Neon PostgreSQL DB (`20260512063747_init_auth_schema`).
- **Libraries added:** `bcryptjs`, `zod`, `express-rate-limit` (already had `jsonwebtoken`, `ioredis`, `cookie-parser`, `nodemon`).
- **Routes:** `POST /api/v1/auth/register`, `/login`, `/refresh`, `/logout`
- **Middleware:** `authenticate`, `scopeTenant`
- **Security:** Refresh token rotation, SHA-256 DB hashing, httpOnly cookie, Zod validation

---

_Add new changelog entries at the top of the Changelog section with the date and a brief summary of what changed._
