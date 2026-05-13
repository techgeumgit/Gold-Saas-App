import { z } from 'zod';

// ── Register ───────────────────────────────────────────────────────────────
export const registerSchema = z.object({
  // Tenant details
  tenantName: z
    .string({ required_error: 'Tenant name is required' })
    .min(2, 'Tenant name must be at least 2 characters')
    .max(100),

  tenantSlug: z
    .string({ required_error: 'Tenant slug is required' })
    .min(2, 'Slug must be at least 2 characters')
    .max(63, 'Slug must be at most 63 characters')
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers, and hyphens'),

  // Owner user details
  name: z
    .string({ required_error: 'Name is required' })
    .min(1, 'Name cannot be empty')
    .max(100),

  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email address'),

  phone: z
    .string()
    .regex(/^\+?[1-9]\d{7,14}$/, 'Invalid phone number')
    .optional(),

  password: z
    .string({ required_error: 'Password is required' })
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password is too long')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

// ── Login ──────────────────────────────────────────────────────────────────
export const loginSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email address'),

  password: z
    .string({ required_error: 'Password is required' })
    .min(1, 'Password cannot be empty'),

  tenantSlug: z
    .string({ required_error: 'Tenant slug is required' })
    .min(1, 'Tenant slug cannot be empty'),
});
