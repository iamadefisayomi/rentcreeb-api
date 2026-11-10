import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { paginate } from '../lib/common';
import { authenticate, requireRole, requirePhoneVerified } from '../middleware/auth';
import { notify } from '../services/notify';

const r = Router();

// ───────── Public ─────────
r.get('/:id/public', async (req, res) => {
  const [p, ap, port, reviews] = await Promise.all([
    db.from('profiles').select('id, first_name, last_name, avatar_url, rating_avg, rating_count, nin_verified, created_at').eq('id', req.params.id).eq('role', 'artisan').maybeSingle(),
    db.from('artisan_profiles').select('skill_category, additional_skills, service_areas, years_experience, bio, available').eq('user_id', req.params.id).eq('review_status', 'approved').maybeSingle(),
    db.from('artisan_portfolio').select('id, url, caption').eq('user_id', req.params.id),
    db.from('job_reviews').select('id, rating, comment, reply, created_at, reviewer:profiles!job_reviews_reviewer_id_fkey(first_name, last_name, role)').eq('reviewee_id', req.params.id).order('created_at', { ascending: false }).limit(20),
  ]);
  if (!p.data || !ap.data) throw notFound('Artisan not found');
  const { count: jobs } = await db.from('jobs').select('id', { count: 'exact', head: true }).eq('artisan_id', req.params.id).eq('status', 'completed');
  res.json({ artisan: { ...p.data, ...ap.data, jobsCompleted: jobs ?? 0 }, portfolio: port.data, reviews: reviews.data });
});

r.use(authenticate, requireRole('artisan'), requirePhoneVerified);

// ───────── Registration steps 1–3 + 5 (step 4 = /verification/nin) ─────────
const profileBody = z.object({
  skillCategory: z.string().optional(), additionalSkills: z.array(z.string()).optional(),
  serviceAreas: z.array(z.string()).optional(), yearsExperience: z.number().int().min(0).max(60).optional(),
  state: z.string().optional(), lga: z.string().optional(), homeAddress: z.string().optional(), bio: z.string().max(300).optional(),
});
r.put('/profile', async (req, res) => {
  const b = profileBody.parse(req.body);
  const row = { user_id: req.user.id, skill_category: b.skillCategory, additional_skills: b.additionalSkills, service_areas: b.serviceAreas,
    years_experience: b.yearsExperience, state: b.state, lga: b.lga, home_address: b.homeAddress, bio: b.bio };
  const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
  res.json({ artisan: unwrap(await db.from('artisan_profiles').upsert(clean).select().single()) });
});

r.get('/me', async (req, res) => {
  const [ap, docs, port, refs] = await Promise.all([
    db.from('artisan_profiles').select('*').eq('user_id', req.user.id).maybeSingle(),
    db.from('artisan_documents').select('id, doc_type, original_name, created_at').eq('user_id', req.user.id),
    db.from('artisan_portfolio').select('*').eq('user_id', req.user.id),
    db.from('artisan_references').select('*').eq('user_id', req.user.id),
  ]);
  res.json({ profile: req.user, artisan: ap.data, documents: docs.data, portfolio: port.data, references: refs.data });
});

/** Register an uploaded private document (path from POST /uploads?folder=artisan-docs). */
r.post('/documents', async (req, res) => {
  const b = z.object({ docType: z.enum(['gov_id', 'trade_certificate', 'other']), path: z.string().startsWith(`artisan-docs/${req.user.id}/`), originalName: z.string().optional() }).parse(req.body);
  res.status(201).json({ document: unwrap(await db.from('artisan_documents').insert({ user_id: req.user.id, doc_type: b.docType, storage_path: b.path, original_name: b.originalName }).select('id, doc_type, original_name').single()) });
});
r.delete('/documents/:id', async (req, res) => { await db.from('artisan_documents').delete().eq('id', req.params.id).eq('user_id', req.user.id); res.status(204).end(); });

r.post('/portfolio', async (req, res) => {
  const b = z.object({ url: z.string().url(), caption: z.string().optional() }).parse(req.body);
  const { count } = await db.from('artisan_portfolio').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id);
  if ((count ?? 0) >= 6) throw badRequest('Maximum 6 portfolio photos', 'PORTFOLIO_FULL');
  res.status(201).json({ item: unwrap(await db.from('artisan_portfolio').insert({ user_id: req.user.id, ...b }).select().single()) });
});
r.delete('/portfolio/:id', async (req, res) => { await db.from('artisan_portfolio').delete().eq('id', req.params.id).eq('user_id', req.user.id); res.status(204).end(); });

r.put('/references', async (req, res) => {
  const { references } = z.object({ references: z.array(z.object({ name: z.string(), phone: z.string() })).max(5) }).parse(req.body);
  await db.from('artisan_references').delete().eq('user_id', req.user.id);
  if (references.length) await db.from('artisan_references').insert(references.map((x) => ({ ...x, user_id: req.user.id })));
  res.status(204).end();
});

/** Final submit: requires profile, gov ID, NIN verified and accepted terms. Admin reviews within 48h. */
r.post('/submit', async (req, res) => {
  const { acceptTerms } = z.object({ acceptTerms: z.literal(true) }).parse(req.body);
  void acceptTerms;
  const { data: ap } = await db.from('artisan_profiles').select('*').eq('user_id', req.user.id).maybeSingle();
  const { count: ids } = await db.from('artisan_documents').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).eq('doc_type', 'gov_id');
  const missing = [
    !ap?.skill_category && 'skills', !ap?.service_areas?.length && 'service_areas', !ids && 'government_id', !req.user.nin_verified && 'nin_verification',
  ].filter(Boolean);
  if (missing.length) throw badRequest('Application incomplete', 'APPLICATION_INCOMPLETE');
  await db.from('artisan_profiles').update({ review_status: 'pending', terms_accepted_at: new Date().toISOString(), submitted_at: new Date().toISOString(), review_note: null }).eq('user_id', req.user.id);
  await db.from('profiles').update({ onboarding_completed: true }).eq('id', req.user.id);
  res.json({ status: 'pending', message: 'Application submitted. We will review it within 48 hours.' });
});

// ───────── After approval ─────────
r.patch('/availability', async (req, res) => {
  const b = z.object({ available: z.boolean(), hours: z.string().max(100).optional() }).parse(req.body);
  await db.from('artisan_profiles').update({ available: b.available, availability_hours: b.hours }).eq('user_id', req.user.id);
  res.status(204).end();
});

r.get('/reviews', async (req, res) => {
  const { from, to } = paginate(req.query);
  const { data } = await db.from('job_reviews').select('*, reviewer:profiles!job_reviews_reviewer_id_fkey(first_name, last_name, role), jobs(category)').eq('reviewee_id', req.user.id).order('created_at', { ascending: false }).range(from, to);
  res.json({ reviews: data });
});
r.post('/reviews/:id/reply', async (req, res) => {
  const { reply } = z.object({ reply: z.string().min(1).max(1000) }).parse(req.body);
  const { data } = await db.from('job_reviews').update({ reply, replied_at: new Date().toISOString() }).eq('id', req.params.id).eq('reviewee_id', req.user.id).select().maybeSingle();
  if (!data) throw forbidden();
  await notify(data.reviewer_id, 'review_reply', 'The artisan replied to your review', reply.slice(0, 100));
  res.json({ review: data });
});

export default r;
