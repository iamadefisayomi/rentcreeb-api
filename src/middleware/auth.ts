import type { NextFunction, Request, Response } from 'express';
import { db } from '../lib/supabase';
import { forbidden, HttpError, unauthorized } from '../lib/errors';

type Role = Profile['role'];

/** Verifies the Supabase access token, then loads the profile. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw unauthorized('Missing bearer token');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw unauthorized('Invalid or expired token');
  const { data: profile } = await db.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (!profile) throw new HttpError(403, 'Profile not found', 'NO_PROFILE');
  if (profile.is_suspended) throw forbidden('Account suspended', 'SUSPENDED');
  req.user = profile as Profile;
  next();
}

export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!roles.includes(req.user.role)) throw forbidden(`Requires role: ${roles.join(' or ')}`);
  next();
};

/** Phone verified (partially verified or better). */
export function requirePhoneVerified(req: Request, _res: Response, next: NextFunction) {
  if (!req.user.phone_verified) throw forbidden('Verify your phone number first', 'PHONE_VERIFICATION_REQUIRED');
  next();
}

/** NIN + selfie verified: required to book, pay, review and list. */
export function requireVerified(req: Request, _res: Response, next: NextFunction) {
  if (req.user.verification_status !== 'verified')
    throw forbidden('Identity verification required', 'VERIFICATION_REQUIRED');
  next();
}
