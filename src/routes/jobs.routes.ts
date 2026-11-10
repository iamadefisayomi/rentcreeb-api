import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { boolish, haversineKm, kobo, paginate, uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { createPayment } from '../services/payments';
import { releaseEscrow } from '../services/escrow';
import { notify } from '../services/notify';

const r = Router();
r.use(authenticate);
const LANDLORDS = ['landlord', 'estate_manager'] as const;

async function artisanApproved(userId: string) {
  const { data } = await db.from('artisan_profiles').select('*').eq('user_id', userId).maybeSingle();
  if (!data || data.review_status !== 'approved') throw forbidden('Your artisan profile is not approved yet', 'ARTISAN_NOT_APPROVED');
  return data;
}
async function getJob(id: string) {
  const { data } = await db.from('jobs').select('*, properties(id, title, address, area, lat, lng, property_media(url, position))').eq('id', id).maybeSingle();
  if (!data) throw notFound('Job not found');
  return data as any;
}
const mustBeAssigned = (job: any, userId: string) => { if (job.artisan_id !== userId) throw forbidden('Job not assigned to you'); };
const mustOwn = (job: any, userId: string) => { if (job.landlord_id !== userId) throw forbidden(); };

// ───────── Landlord: create / list / accept ─────────
r.post('/', requireRole(...LANDLORDS), requireVerified, async (req, res) => {
  const b = z.object({
    propertyId: uuid, title: z.string().min(3), category: z.string(), description: z.string().min(5),
    urgency: z.enum(['standard', 'urgent']).default('standard'), budgetMinKobo: kobo, budgetMaxKobo: kobo,
    accessNotes: z.string().optional(), mediaUrls: z.array(z.string().url()).max(6).default([]),
  }).parse(req.body);
  if (b.budgetMinKobo > b.budgetMaxKobo) throw badRequest('Min budget cannot exceed max');
  const { data: p } = await db.from('properties').select('owner_id').eq('id', b.propertyId).maybeSingle();
  if (!p || p.owner_id !== req.user.id) throw forbidden('Not your property');
  const job = unwrap(await db.from('jobs').insert({
    property_id: b.propertyId, landlord_id: req.user.id, title: b.title, category: b.category, description: b.description,
    urgency: b.urgency, budget_min_kobo: b.budgetMinKobo, budget_max_kobo: b.budgetMaxKobo, access_notes: b.accessNotes }).select().single());
  if (b.mediaUrls.length) await db.from('job_media').insert(b.mediaUrls.map((url) => ({ job_id: job.id, kind: 'issue', url })));
  res.status(201).json({ job });
});

r.get('/mine', requireRole(...LANDLORDS), async (req, res) => {
  const { data } = await db.from('jobs').select('*, job_quotes(count), properties(title)').eq('landlord_id', req.user.id).order('created_at', { ascending: false });
  res.json({ jobs: data });
});

/** Accepting a quote starts an escrow payment; the job is assigned once Paystack confirms. */
r.post('/quotes/:quoteId/accept', requireRole(...LANDLORDS), requireVerified, async (req, res) => {
  const { data: q } = await db.from('job_quotes').select('*, jobs(*)').eq('id', req.params.quoteId).maybeSingle();
  if (!q) throw notFound('Quote not found');
  const job = (q as any).jobs;
  mustOwn(job, req.user.id);
  if (job.status !== 'open' || q.status !== 'pending') throw conflict('This job already has an accepted quote', 'BAD_STATE');
  const payment = await createPayment(req.user, 'job_escrow', Number(q.amount_kobo), { job_id: job.id, quote_id: q.id });
  res.status(201).json({ payment });
});

r.get('/:id/quotes', requireRole(...LANDLORDS), async (req, res) => {
  mustOwn(await getJob(req.params.id), req.user.id);
  const { data } = await db.from('job_quotes').select('*, artisan:profiles!job_quotes_artisan_id_fkey(id, first_name, last_name, avatar_url, rating_avg, rating_count, artisan_profiles(skill_category, years_experience))')
    .eq('job_id', req.params.id).order('created_at');
  res.json({ quotes: data });
});

/** Landlord reviews the artisan's diagnosis before repairs begin. */
r.post('/:id/report/:decision', requireRole(...LANDLORDS), async (req, res) => {
  const decisionParam = z.enum(['approve', 'reject']).parse(req.params.decision);
  const { note } = z.object({ note: z.string().optional() }).parse(req.body ?? {});
  const job = await getJob(req.params.id);
  mustOwn(job, req.user.id);
  if (job.status !== 'awaiting_approval') throw badRequest('No report awaiting approval', 'BAD_STATE');
  const approve = decisionParam === 'approve';
  await db.from('job_reports').update({ status: approve ? 'approved' : 'rejected', review_note: note }).eq('job_id', job.id).eq('status', 'pending');
  await db.from('jobs').update({ status: approve ? 'approved' : 'diagnosing' }).eq('id', job.id);
  await notify(job.artisan_id, approve ? 'report_approved' : 'report_rejected', approve ? 'Approved! 🎉' : 'Diagnosis needs changes', approve ? 'You may begin the repair.' : note ?? 'Please revise your report.', { jobId: job.id });
  res.json({ status: approve ? 'approved' : 'diagnosing' });
});

/** Tenant (or landlord) confirms the work → escrow released to artisan wallet minus 5% fee. */
r.post('/:id/confirm-completion', async (req, res) => {
  const job = await getJob(req.params.id);
  if (![job.tenant_id, job.landlord_id].includes(req.user.id)) throw forbidden();
  if (job.status !== 'awaiting_confirmation') throw badRequest('Job is not awaiting confirmation', 'BAD_STATE');
  const { data: e } = await db.from('escrows').select('id').eq('job_id', job.id).eq('kind', 'job').eq('status', 'held').maybeSingle();
  if (!e) throw conflict('No escrow found for this job');
  const released = await releaseEscrow(e.id);
  await db.from('jobs').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', job.id);
  if (job.maintenance_request_id) await db.from('maintenance_requests').update({ status: 'completed' }).eq('id', job.maintenance_request_id);
  await notify(job.artisan_id, 'payment_released', 'Payment released! 🎉', `₦${((released!.amount_kobo - released!.fee_kobo) / 100).toLocaleString()} credited to your wallet.`, { jobId: job.id });
  res.json({ status: 'completed' });
});

/** Rate the other party after completion (landlord/tenant → artisan, artisan → landlord). */
r.post('/:id/review', async (req, res) => {
  const b = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }).parse(req.body);
  const job = await getJob(req.params.id);
  if (job.status !== 'completed') throw badRequest('Job is not completed', 'BAD_STATE');
  let reviewee: string;
  if (req.user.id === job.artisan_id) reviewee = job.landlord_id;
  else if ([job.landlord_id, job.tenant_id].includes(req.user.id)) reviewee = job.artisan_id;
  else throw forbidden();
  const { data: dup } = await db.from('job_reviews').select('id').eq('job_id', job.id).eq('reviewer_id', req.user.id).maybeSingle();
  if (dup) throw conflict('Already reviewed');
  res.status(201).json({ review: unwrap(await db.from('job_reviews').insert({ job_id: job.id, reviewer_id: req.user.id, reviewee_id: reviewee, rating: b.rating, comment: b.comment }).select().single()) });
});

// ───────── Artisan: alerts, detail, quotes, work ─────────
/** Job alerts: matches the artisan's skill, hides declined/quoted jobs. ?category&sort=newest|closest|budget&lat&lng&urgent */
r.get('/alerts', requireRole('artisan'), async (req, res) => {
  const ap = await artisanApproved(req.user.id);
  const { from, to } = paginate(req.query);
  const q = z.object({ category: z.string().optional(), sort: z.enum(['newest', 'closest', 'budget']).default('newest'),
    lat: z.coerce.number().optional(), lng: z.coerce.number().optional(), urgent: boolish.optional() }).parse(req.query);

  const [{ data: declined }, { data: quoted }] = await Promise.all([
    db.from('job_declines').select('job_id').eq('artisan_id', req.user.id),
    db.from('job_quotes').select('job_id').eq('artisan_id', req.user.id),
  ]);
  const skip = new Set([...(declined ?? []), ...(quoted ?? [])].map((x) => x.job_id));
  let query = db.from('jobs').select('*, properties(area, lat, lng), job_quotes(count)').eq('status', 'open');
  const cat = q.category ?? ap.skill_category;
  if (cat) query = query.ilike('category', cat);
  if (q.urgent) query = query.eq('urgency', 'urgent');
  const { data } = await query.order('created_at', { ascending: false }).limit(200);

  let jobs = (data ?? []).filter((j: any) => !skip.has(j.id)).map((j: any) => ({
    ...j, quotesCount: j.job_quotes?.[0]?.count ?? 0,
    distanceKm: q.lat != null && q.lng != null && j.properties?.lat != null ? +haversineKm(q.lat, q.lng, j.properties.lat, j.properties.lng).toFixed(1) : null,
  }));
  if (q.sort === 'closest') jobs.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  if (q.sort === 'budget') jobs.sort((a, b) => Number(b.budget_max_kobo) - Number(a.budget_max_kobo));
  res.json({ jobs: jobs.slice(from, to + 1), total: jobs.length });
});

r.get('/quotes/mine', requireRole('artisan'), async (req, res) => {
  const { data } = await db.from('job_quotes').select('*, jobs(id, title, status, budget_min_kobo, budget_max_kobo, properties(area))').eq('artisan_id', req.user.id).order('created_at', { ascending: false });
  res.json({ quotes: data });
});

r.get('/assigned', requireRole('artisan'), async (req, res) => {
  const { status } = z.object({ status: z.string().optional() }).parse(req.query);
  let q = db.from('jobs').select('*, properties(title, address, area)').eq('artisan_id', req.user.id).order('created_at', { ascending: false });
  if (status) q = q.in('status', status.split(','));
  res.json({ jobs: (await q).data });
});

/** Detail. Full address is only revealed to the owner and the assigned artisan. */
r.get('/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  const privileged = [job.landlord_id, job.tenant_id, job.artisan_id].includes(req.user.id);
  if (!privileged && req.user.role !== 'artisan') throw forbidden();
  const [media, landlord, quotes, myQuote, report] = await Promise.all([
    db.from('job_media').select('kind, url').eq('job_id', job.id),
    db.from('profiles').select('id, first_name, last_name, avatar_url, rating_avg, nin_verified').eq('id', job.landlord_id).single(),
    db.from('job_quotes').select('id', { count: 'exact', head: true }).eq('job_id', job.id),
    db.from('job_quotes').select('*').eq('job_id', job.id).eq('artisan_id', req.user.id).maybeSingle(),
    db.from('job_reports').select('*').eq('job_id', job.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const { properties, ...rest } = job;
  res.json({
    job: { ...rest, property: privileged ? properties : { area: properties.area, lat: properties.lat, lng: properties.lng },
           access_notes: privileged ? job.access_notes : null },
    media: media.data, landlord: landlord.data, quotesCount: quotes.count ?? 0, myQuote: myQuote.data, report: privileged ? report.data : null,
  });
});

r.post('/:id/decline', requireRole('artisan'), async (req, res) => {
  await db.from('job_declines').upsert({ job_id: req.params.id, artisan_id: req.user.id });
  res.status(204).end();
});

r.post('/:id/quotes', requireRole('artisan'), requireVerified, async (req, res) => {
  await artisanApproved(req.user.id);
  const b = z.object({
    amountKobo: kobo, eta: z.enum(['same_day', '1_day', '2_3_days', '1_week']).optional(), notes: z.string().max(1000).optional(),
    breakdown: z.array(z.object({ item: z.string(), amountKobo: z.number().int().min(0) })).default([]),
  }).parse(req.body);
  const job = await getJob(req.params.id);
  if (job.status !== 'open') throw badRequest('Job is no longer open', 'BAD_STATE');
  if (b.amountKobo < job.budget_min_kobo || b.amountKobo > job.budget_max_kobo) throw badRequest('Your quote must be within the landlord’s budget range', 'OUT_OF_BUDGET');
  if (b.breakdown.length && b.breakdown.reduce((s, x) => s + x.amountKobo, 0) !== b.amountKobo) throw badRequest('Breakdown must add up to your quote', 'BAD_BREAKDOWN');
  const { data: dup } = await db.from('job_quotes').select('id').eq('job_id', job.id).eq('artisan_id', req.user.id).maybeSingle();
  if (dup) throw conflict('You already quoted this job');
  const quote = unwrap(await db.from('job_quotes').insert({ job_id: job.id, artisan_id: req.user.id, amount_kobo: b.amountKobo, breakdown: b.breakdown, eta: b.eta, notes: b.notes }).select().single());
  await notify(job.landlord_id, 'new_quote', 'New quote received', `${job.title}: ₦${(b.amountKobo / 100).toLocaleString()}`, { jobId: job.id, quoteId: quote.id });
  res.status(201).json({ quote });
});

/** Artisan arrives on site → diagnosing. */
r.post('/:id/start', requireRole('artisan'), async (req, res) => {
  const job = await getJob(req.params.id);
  mustBeAssigned(job, req.user.id);
  if (job.status !== 'assigned') throw badRequest('Job cannot be started', 'BAD_STATE');
  await db.from('jobs').update({ status: 'diagnosing', started_at: new Date().toISOString() }).eq('id', job.id);
  await notify(job.landlord_id, 'job_started', 'Artisan has arrived', job.title, { jobId: job.id });
  res.json({ status: 'diagnosing' });
});

/** Inspection / diagnostic report. Landlord must approve before repairs. */
r.post('/:id/report', requireRole('artisan'), async (req, res) => {
  const b = z.object({
    diagnosis: z.string().min(5),
    materials: z.array(z.object({ item: z.string(), qty: z.number().int().positive(), costKobo: z.number().int().min(0) })).default([]),
    laborKobo: z.number().int().min(0), estimatedCompletion: z.coerce.date().optional(),
    beforeMediaUrls: z.array(z.string().url()).max(4).default([]),
  }).parse(req.body);
  const job = await getJob(req.params.id);
  mustBeAssigned(job, req.user.id);
  if (job.status !== 'diagnosing') throw badRequest('Start the job before submitting a report', 'BAD_STATE');
  const total = b.materials.reduce((s, m) => s + m.qty * m.costKobo, 0) + b.laborKobo;
  const { data: quote } = await db.from('job_quotes').select('amount_kobo').eq('id', job.accepted_quote_id).single();
  const report = unwrap(await db.from('job_reports').insert({
    job_id: job.id, artisan_id: req.user.id, diagnosis: b.diagnosis, materials: b.materials, labor_kobo: b.laborKobo, total_kobo: total,
    est_completion: b.estimatedCompletion?.toISOString(), exceeds_quote: total > Number(quote?.amount_kobo ?? 0) }).select().single());
  if (b.beforeMediaUrls.length) await db.from('job_media').insert(b.beforeMediaUrls.map((url) => ({ job_id: job.id, kind: 'before', url })));
  await db.from('jobs').update({ status: 'awaiting_approval' }).eq('id', job.id);
  await notify(job.landlord_id, 'report_submitted', 'Diagnosis report submitted', 'Review and approve to let the artisan proceed.', { jobId: job.id });
  res.status(201).json({ report });
});

r.post('/:id/begin-repair', requireRole('artisan'), async (req, res) => {
  const job = await getJob(req.params.id);
  mustBeAssigned(job, req.user.id);
  if (job.status !== 'approved') throw badRequest('Landlord approval required first', 'BAD_STATE');
  await db.from('jobs').update({ status: 'in_progress' }).eq('id', job.id);
  res.json({ status: 'in_progress' });
});

/** Artisan submits proof of completion; escrow releases after the tenant confirms. */
r.post('/:id/complete', requireRole('artisan'), async (req, res) => {
  const b = z.object({ afterMediaUrls: z.array(z.string().url()).min(1, 'At least one after photo is required').max(6), notes: z.string().max(1000).optional() }).parse(req.body);
  const job = await getJob(req.params.id);
  mustBeAssigned(job, req.user.id);
  if (job.status !== 'in_progress') throw badRequest('Job is not in progress', 'BAD_STATE');
  await db.from('job_media').insert(b.afterMediaUrls.map((url) => ({ job_id: job.id, kind: 'after', url })));
  await db.from('jobs').update({ status: 'awaiting_confirmation' }).eq('id', job.id);
  for (const uid of [job.tenant_id, job.landlord_id].filter(Boolean))
    await notify(uid, 'job_complete', 'Repair finished — please confirm', job.title, { jobId: job.id });
  res.json({ status: 'awaiting_confirmation' });
});

export default r;
