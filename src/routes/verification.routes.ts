import { Router } from 'express';
import multer from 'multer';
import { createHash } from 'crypto';
import { z } from 'zod';
import { env } from '../config/env';
import { db } from '../lib/supabase';
import { badRequest, conflict, HttpError } from '../lib/errors';
import { boolish } from '../lib/common';
import { verifyNinWithSelfie } from '../lib/dojah';
import { authenticate } from '../middleware/auth';
import { notify } from '../services/notify';

const r = Router();
r.use(authenticate);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const hashNin = (nin: string) => createHash('sha256').update(nin + env.OTP_PEPPER).digest('hex');

async function failedAttempts(userId: string) {
  const { count } = await db.from('verifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'failed');
  return count ?? 0;
}

r.get('/status', async (req, res) => {
  const used = await failedAttempts(req.user.id);
  res.json({
    status: req.user.verification_status,
    access: { unverified: 'browse_only', partially_verified: 'limited_actions', verified: 'full_access' }[req.user.verification_status],
    attemptsUsed: used, attemptsRemaining: Math.max(0, env.NIN_MAX_ATTEMPTS - used),
  });
});

/** multipart/form-data: nin, consent, selfie (image). The selfie is forwarded to Dojah and never stored. */
r.post('/nin', upload.single('selfie'), async (req, res) => {
  const { nin, consent } = z.object({ nin: z.string().regex(/^\d{11}$/, 'NIN must be 11 digits'), consent: boolish }).parse(req.body);
  if (!consent) throw badRequest('Consent is required', 'CONSENT_REQUIRED');
  if (!req.file) throw badRequest('Selfie image is required', 'SELFIE_REQUIRED');
  if (req.user.nin_verified) throw conflict('Already verified', 'ALREADY_VERIFIED');

  const used = await failedAttempts(req.user.id);
  if (used >= env.NIN_MAX_ATTEMPTS)
    throw new HttpError(429, 'Maximum attempts reached', 'VERIFICATION_LOCKED', { suggestions: ['fix_issue', 'contact_support', 'manual_verification'] });

  const ninHash = hashNin(nin);
  const { data: dup } = await db.from('verifications').select('user_id').eq('nin_hash', ninHash).eq('status', 'success').maybeSingle();
  if (dup && dup.user_id !== req.user.id) throw conflict('This NIN is linked to another account', 'NIN_IN_USE');

  const record = { user_id: req.user.id, nin_hash: ninHash, nin_last3: nin.slice(-3) };
  try {
    const result = await verifyNinWithSelfie(nin, req.file.buffer.toString('base64'));
    if (!result.match || result.confidence < env.DOJAH_MIN_CONFIDENCE) {
      await db.from('verifications').insert({ ...record, status: 'failed', confidence: result.confidence, failure_reason: 'FACE_MISMATCH' });
      throw new HttpError(422, 'We could not match your selfie to your NIN record', 'FACE_MISMATCH', { attemptsRemaining: Math.max(0, env.NIN_MAX_ATTEMPTS - used - 1) });
    }
    await db.from('verifications').insert({ ...record, status: 'success', confidence: result.confidence });
    await db.from('profiles').update({ nin_verified: true, updated_at: new Date().toISOString() }).eq('id', req.user.id);
    await notify(req.user.id, 'verified', 'Identity verified ✅', 'You now have full access to RentCreeb.');
    res.json({ status: 'verified', ninLast3: nin.slice(-3) });
  } catch (err) {
    // Only count NIN-not-found as a user attempt; provider outages shouldn't burn attempts.
    if (err instanceof HttpError && err.code === 'NIN_NOT_FOUND')
      await db.from('verifications').insert({ ...record, status: 'failed', failure_reason: 'NIN_NOT_FOUND' });
    throw err;
  }
});

/** After max attempts: ask for manual review (admin approves via /admin). */
r.post('/manual-request', async (req, res) => {
  const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body);
  await db.from('verifications').insert({ user_id: req.user.id, nin_hash: 'manual:' + req.user.id, nin_last3: '---', status: 'manual_review', metadata: { note } });
  res.status(202).json({ message: 'Request received. Our team will contact you by email.' });
});

export default r;
