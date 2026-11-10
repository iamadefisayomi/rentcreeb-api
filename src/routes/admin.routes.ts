import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { notFound } from '../lib/errors';
import { signPrivateUrl } from '../lib/bunny';
import { paginate, uuid } from '../lib/common';
import { authenticate, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';

const r = Router();
r.use(authenticate, requireRole('admin'));

const decision = z.object({ approve: z.boolean(), reason: z.string().optional() });

// Property approvals ("Send for approval → approved/rejected")
r.get('/properties/pending', async (_req, res) =>
  res.json({ properties: (await db.from('properties').select('*, property_media(url), owner:profiles!properties_owner_id_fkey(first_name, last_name, role)').eq('status', 'pending').order('created_at')).data }));

r.post('/properties/:id/decision', async (req, res) => {
  const b = decision.parse(req.body);
  const p = unwrap(await db.from('properties').update(b.approve
    ? { status: 'approved', is_verified: true, rejection_reason: null } : { status: 'rejected', rejection_reason: b.reason ?? 'Does not meet listing requirements' })
    .eq('id', req.params.id).eq('status', 'pending').select().maybeSingle());
  if (!p) throw notFound('Pending property not found');
  await notify(p.owner_id, b.approve ? 'listing_approved' : 'listing_rejected', b.approve ? 'Listing approved ✅' : 'Listing rejected', b.approve ? p.title : (b.reason ?? 'Edit and resubmit.'), { propertyId: p.id });
  res.json({ property: p });
});

// Artisan applications
r.get('/artisans/pending', async (_req, res) =>
  res.json({ artisans: (await db.from('artisan_profiles').select('*, profiles(first_name, last_name, phone, email, nin_verified), artisan_documents(id, doc_type)').eq('review_status', 'pending').order('submitted_at')).data }));

/** Short-lived signed URL to view a private document. */
r.get('/artisan-documents/:id/url', async (req, res) => {
  const { data } = await db.from('artisan_documents').select('storage_path').eq('id', req.params.id).maybeSingle();
  if (!data) throw notFound();
  res.json({ url: signPrivateUrl(data.storage_path, 300) });
});

r.post('/artisans/:userId/decision', async (req, res) => {
  const b = decision.parse(req.body);
  const a = unwrap(await db.from('artisan_profiles').update(b.approve
    ? { review_status: 'approved', approved_at: new Date().toISOString(), review_note: null } : { review_status: 'rejected', review_note: b.reason })
    .eq('user_id', req.params.userId).eq('review_status', 'pending').select().maybeSingle());
  if (!a) throw notFound('Pending application not found');
  await notify(a.user_id, b.approve ? 'artisan_approved' : 'artisan_rejected', b.approve ? 'You’re now a Verified Artisan! 🎉' : 'Application needs changes', b.approve ? 'Your profile is now visible and you can receive job alerts.' : (b.reason ?? ''));
  res.json({ artisan: a });
});

// Manual NIN verification fallback & moderation
r.post('/users/:id/verify', async (req, res) => {
  await db.from('profiles').update({ nin_verified: true }).eq('id', req.params.id);
  await db.from('verifications').update({ status: 'success' }).eq('user_id', req.params.id).eq('status', 'manual_review');
  await notify(req.params.id, 'verified', 'Identity verified ✅', 'Your account is now fully verified.');
  res.status(204).end();
});
r.post('/users/:id/suspend', async (req, res) => {
  const { suspended } = z.object({ suspended: z.boolean() }).parse(req.body);
  await db.from('profiles').update({ is_suspended: suspended }).eq('id', req.params.id);
  res.status(204).end();
});

r.get('/reports', async (req, res) => {
  const { from, to } = paginate(req.query);
  res.json({ reports: (await db.from('reports').select('*, reporter:profiles!reports_reporter_id_fkey(first_name, last_name), agent:profiles!reports_agent_id_fkey(first_name, last_name)').order('created_at', { ascending: false }).range(from, to)).data });
});
r.patch('/reports/:id', async (req, res) => {
  const b = z.object({ status: z.enum(['open', 'investigating', 'resolved', 'dismissed']), adminNote: z.string().optional() }).parse(req.body);
  res.json({ report: unwrap(await db.from('reports').update({ status: b.status, admin_note: b.adminNote }).eq('id', uuid.parse(req.params.id)).select().single()) });
});
r.post('/reviews/:id/hide', async (req, res) => {
  const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
  await db.from('reviews').update({ hidden }).eq('id', req.params.id);
  res.status(204).end();
});

export default r;
