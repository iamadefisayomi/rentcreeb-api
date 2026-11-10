import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { db } from './supabase';
import { HttpError } from './errors';

export type OtpPurpose = 'phone_verify' | 'booking_confirm' | 'booking_inspection';
const TTL_MIN: Record<OtpPurpose, number> = { phone_verify: 10, booking_confirm: 30, booking_inspection: 60 * 24 * 3 };
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 45;

const hash = (code: string) => createHash('sha256').update(code + env.OTP_PEPPER).digest('hex');

interface Scope { purpose: OtpPurpose; userId?: string; bookingId?: string }

function scoped(s: Scope) {
  let q = db.from('otp_codes').select('*').eq('purpose', s.purpose);
  if (s.userId) q = q.eq('user_id', s.userId);
  if (s.bookingId) q = q.eq('booking_id', s.bookingId);
  return q;
}

/** Creates a new OTP (invalidating older ones for the same scope) and returns the plain code. */
export async function issueOtp(s: Scope & { phone?: string }) {
  const { data: last } = await scoped(s).is('consumed_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - new Date(last.created_at).getTime() < RESEND_COOLDOWN_SEC * 1000)
    throw new HttpError(429, `Please wait ${RESEND_COOLDOWN_SEC}s before requesting another code`, 'OTP_COOLDOWN');

  let del = db.from('otp_codes').delete().eq('purpose', s.purpose).is('consumed_at', null);
  if (s.userId) del = del.eq('user_id', s.userId);
  if (s.bookingId) del = del.eq('booking_id', s.bookingId);
  await del;

  const code = randomInt(100000, 1000000).toString();
  await db.from('otp_codes').insert({
    purpose: s.purpose, user_id: s.userId ?? null, booking_id: s.bookingId ?? null, phone: s.phone ?? null,
    code_hash: hash(code), expires_at: new Date(Date.now() + TTL_MIN[s.purpose] * 60000).toISOString(),
  });
  return code;
}

/** Throws on invalid/expired/locked. Marks consumed on success. */
export async function verifyOtp(s: Scope, code: string) {
  const { data: row } = await scoped(s).is('consumed_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!row) throw new HttpError(400, 'No active code. Request a new one.', 'OTP_NOT_FOUND');
  if (new Date(row.expires_at) < new Date()) throw new HttpError(400, 'Code expired. Request a new one.', 'OTP_EXPIRED');
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many attempts. Request a new code.', 'OTP_LOCKED');

  const a = Buffer.from(hash(code), 'hex');
  const b = Buffer.from(row.code_hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await db.from('otp_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
    throw new HttpError(400, 'Invalid code. Please try again.', 'OTP_INVALID');
  }
  await db.from('otp_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);
  return row;
}
