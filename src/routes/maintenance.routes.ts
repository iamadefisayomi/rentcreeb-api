import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { kobo, uuid } from '../lib/common';
import { authenticate, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';

const r = Router();
r.use(authenticate);
const SELECT = '*, maintenance_media(url), properties(id, title, address), jobs(id, status, artisan_id, title, accepted_quote_id)';

/** Tenant: photo upload → category → submit. */
r.post('/', requireRole('tenant'), async (req, res) => {
  const b = z.object({
    tenancyId: uuid, category: z.string().min(2), description: z.string().min(5),
    urgency: z.enum(['standard', 'urgent']).default('standard'), mediaUrls: z.array(z.string().url()).max(6).default([]),
  }).parse(req.body);
  const { data: t } = await db.from('tenancies').select('*').eq('id', b.tenancyId).eq('tenant_id', req.user.id).eq('status', 'active').maybeSingle();
  if (!t) throw notFound('Active tenancy not found');
  const m = unwrap(await db.from('maintenance_requests').insert({
    tenancy_id: t.id, property_id: t.property_id, tenant_id: req.user.id, landlord_id: t.landlord_id,
    category: b.category, description: b.description, urgency: b.urgency }).select().single());
  if (b.mediaUrls.length) await db.from('maintenance_media').insert(b.mediaUrls.map((url) => ({ request_id: m.id, url })));
  await notify(t.landlord_id, 'maintenance_request', 'New maintenance request', `${b.category}: ${b.description.slice(0, 80)}`, { requestId: m.id });
  res.status(201).json({ request: m });
});

r.get('/', async (req, res) => {
  const { status } = z.object({ status: z.string().optional() }).parse(req.query);
  const col = req.user.role === 'tenant' ? 'tenant_id' : 'landlord_id';
  let q = db.from('maintenance_requests').select(SELECT).eq(col, req.user.id).order('created_at', { ascending: false });
  if (status) q = q.in('status', status.split(','));
  res.json({ requests: (await q).data });
});

/** Repair status tracking: request + linked job + timeline. */
r.get('/:id', async (req, res) => {
  const { data } = await db.from('maintenance_requests').select(SELECT).eq('id', req.params.id).maybeSingle();
  if (!data) throw notFound('Request not found');
  if (![data.tenant_id, data.landlord_id].includes(req.user.id)) throw forbidden();
  const job = (data as any).jobs?.[0];
  const stages = ['open', 'job_posted', 'assigned', 'diagnosing', 'awaiting_approval', 'approved', 'in_progress', 'awaiting_confirmation', 'completed'];
  const current = job ? job.status : data.status === 'rejected' ? 'rejected' : data.status;
  res.json({ request: data, job: job ?? null, timeline: { stages, current } });
});

/** Landlord approves the ticket by posting it as a job for artisans. */
r.post('/:id/post-job', requireRole('landlord', 'estate_manager'), async (req, res) => {
  const b = z.object({ budgetMinKobo: kobo, budgetMaxKobo: kobo, urgency: z.enum(['standard', 'urgent']).optional(), accessNotes: z.string().optional() }).parse(req.body);
  if (b.budgetMinKobo > b.budgetMaxKobo) throw badRequest('Min budget cannot exceed max');
  const { data: m } = await db.from('maintenance_requests').select('*, maintenance_media(url)').eq('id', req.params.id).maybeSingle();
  if (!m) throw notFound('Request not found');
  if (m.landlord_id !== req.user.id) throw forbidden();
  if (m.status !== 'open') throw badRequest('Request already processed', 'BAD_STATE');

  const job = unwrap(await db.from('jobs').insert({
    property_id: m.property_id, landlord_id: m.landlord_id, tenant_id: m.tenant_id, maintenance_request_id: m.id,
    title: `${m.category} — ${m.description.slice(0, 40)}`, category: m.category, description: m.description,
    urgency: b.urgency ?? m.urgency, budget_min_kobo: b.budgetMinKobo, budget_max_kobo: b.budgetMaxKobo, access_notes: b.accessNotes,
  }).select().single());
  const media = ((m as any).maintenance_media ?? []).map((x: any) => ({ job_id: job.id, kind: 'issue', url: x.url }));
  if (media.length) await db.from('job_media').insert(media);
  await db.from('maintenance_requests').update({ status: 'job_posted' }).eq('id', m.id);
  await notify(m.tenant_id, 'maintenance_update', 'Repair approved', 'Your landlord is finding an artisan.', { requestId: m.id });
  res.status(201).json({ job });
});

r.post('/:id/reject', requireRole('landlord', 'estate_manager'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
  const { data: m } = await db.from('maintenance_requests').update({ status: 'rejected', rejection_reason: reason })
    .eq('id', req.params.id).eq('landlord_id', req.user.id).eq('status', 'open').select().maybeSingle();
  if (!m) throw notFound('Open request not found');
  await notify(m.tenant_id, 'maintenance_update', 'Request declined', reason, { requestId: m.id });
  res.json({ request: m });
});

export default r;
