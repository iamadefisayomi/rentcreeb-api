import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGINS: z.string().default('*'),
  APP_BASE_URL: z.string().default('https://rentcreeb.com'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PASSWORD_RESET_REDIRECT_URL: z.string().min(1),

  OTP_PEPPER: z.string().min(16),

  AT_USERNAME: z.string().default('sandbox'),
  AT_API_KEY: z.string().optional(),
  AT_SENDER_ID: z.string().optional(),

  DOJAH_BASE_URL: z.string().default('https://sandbox.dojah.io'),
  DOJAH_APP_ID: z.string().min(1),
  DOJAH_SECRET_KEY: z.string().min(1),
  DOJAH_MIN_CONFIDENCE: z.coerce.number().default(70),
  NIN_MAX_ATTEMPTS: z.coerce.number().default(3),

  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_CALLBACK_URL: z.string().optional(),

  BUNNY_STORAGE_HOST: z.string().default('storage.bunnycdn.com'),
  BUNNY_STORAGE_ZONE: z.string().min(1),
  BUNNY_STORAGE_KEY: z.string().min(1),
  BUNNY_CDN_URL: z.string().url(),
  BUNNY_PRIVATE_STORAGE_ZONE: z.string().optional(),
  BUNNY_PRIVATE_STORAGE_KEY: z.string().optional(),
  BUNNY_PRIVATE_CDN_URL: z.string().optional(),
  BUNNY_PRIVATE_TOKEN_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('RentCreeb <no-reply@rentcreeb.com>'),

  INSPECTION_FEE_KOBO: z.coerce.number().default(500000),
  INSPECTION_PLATFORM_FEE_PCT: z.coerce.number().default(10),
  JOB_PLATFORM_FEE_PCT: z.coerce.number().default(5),
  BOOKING_CANCEL_CHARGE_PCT: z.coerce.number().default(10),
  BOOKING_FREE_CANCEL_HOURS: z.coerce.number().default(24),
});

export const env = schema.parse(process.env);
export const isProd = env.NODE_ENV === 'production';
