import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { forbidden, notFound } from '../lib/errors';
import { authenticate } from '../middleware/auth';

const r = Router();
const PUBLIC_COLS = 'id, role, first_name, last_name, avatar_url, bio, rating_avg, rating_count, nin_verified, created_at';

r.get('/me', authenticate, async (req, res) => {
  const wallet = (await db.from('wallets').select('available_kobo').eq('user_id', req.user.id).maybeSingle()).data;
  res.json({ profile: req.user, wallet });
});

/** Settings & profile management. Role can only be (re)chosen during onboarding (e.g. after Google/Apple sign-in). */
r.patch('/me', authenticate, async (req, res) => {
  const b = z.object({
    firstName: z.string().min(2).optional(), lastName: z.string().min(2).optional(),
    avatarUrl: z.string().url().nullable().optional(), bio: z.string().max(300).optional(),
    role: z.enum(['tenant', 'landlord', 'estate_manager', 'artisan', 'agent']).optional(),
    onboardingCompleted: z.boolean().optional(),
  }).parse(req.body);
  if (b.role && req.user.onboarding_completed && b.role !== req.user.role) throw forbidden('Role cannot be changed after onboarding');
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.firstName) patch.first_name = b.firstName;
  if (b.lastName) patch.last_name = b.lastName;
  if (b.avatarUrl !== undefined) patch.avatar_url = b.avatarUrl;
  if (b.bio !== undefined) patch.bio = b.bio;
  if (b.role) patch.role = b.role;
  if (b.onboardingCompleted) patch.onboarding_completed = true;
  res.json({ profile: unwrap(await db.from('profiles').update(patch).eq('id', req.user.id).select().single()) });
});

r.put('/me/push-token', authenticate, async (req, res) => {
  const { token } = z.object({ token: z.string().nullable() }).parse(req.body);
  await db.from('profiles').update({ expo_push_token: token }).eq('id', req.user.id);
  res.status(204).end();
});

r.get('/:id', async (req, res) => {
  const { data } = await db.from('profiles').select(PUBLIC_COLS).eq('id', req.params.id).maybeSingle();
  if (!data) throw notFound('User not found');
  res.json({ profile: data });
});

export default r;
