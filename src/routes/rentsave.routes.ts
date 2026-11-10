import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, notFound } from '../lib/errors';
import { kobo, uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { createPayment } from '../services/payments';

const r = Router();
r.use(authenticate, requireRole('tenant'));

const withProgress = (p: any) => ({ ...p, progressPercent: Math.min(100, Math.round((Number(p.saved_kobo) / Number(p.target_kobo)) * 100)) });

/** Setup: amount → frequency → progress. */
r.post('/', requireVerified, async (req, res) => {
  const b = z.object({
    name: z.string().default('Rent Savings'), targetKobo: kobo, contributionKobo: kobo,
    frequency: z.enum(['daily', 'weekly', 'monthly']), targetDate: z.string().date().optional(), tenancyId: uuid.optional(),
  }).parse(req.body);
  if (b.contributionKobo > b.targetKobo) throw badRequest('Contribution cannot exceed target');
  const plan = unwrap(await db.from('rentsave_plans').insert({
    tenant_id: req.user.id, name: b.name, target_kobo: b.targetKobo, contribution_kobo: b.contributionKobo,
    frequency: b.frequency, target_date: b.targetDate, tenancy_id: b.tenancyId }).select().single());
  res.status(201).json({ plan: withProgress(plan) });
});

r.get('/', async (req, res) =>
  res.json({ plans: ((await db.from('rentsave_plans').select('*').eq('tenant_id', req.user.id).order('created_at', { ascending: false })).data ?? []).map(withProgress) }));

r.patch('/:id', async (req, res) => {
  const b = z.object({ status: z.enum(['active', 'paused']).optional(), contributionKobo: kobo.optional(), frequency: z.enum(['daily', 'weekly', 'monthly']).optional() }).parse(req.body);
  const { data } = await db.from('rentsave_plans').update({ status: b.status, contribution_kobo: b.contributionKobo, frequency: b.frequency })
    .eq('id', req.params.id).eq('tenant_id', req.user.id).select().maybeSingle();
  if (!data) throw notFound('Plan not found');
  res.json({ plan: withProgress(data) });
});

/** Add money to the plan via Paystack (default amount = plan contribution). */
r.post('/:id/contribute', requireVerified, async (req, res) => {
  const { amountKobo } = z.object({ amountKobo: kobo.optional() }).parse(req.body ?? {});
  const { data: plan } = await db.from('rentsave_plans').select('*').eq('id', req.params.id).eq('tenant_id', req.user.id).maybeSingle();
  if (!plan) throw notFound('Plan not found');
  if (plan.status !== 'active') throw badRequest('Plan is not active');
  res.status(201).json({ payment: await createPayment(req.user, 'rentsave', amountKobo ?? Number(plan.contribution_kobo), { rentsave_plan_id: plan.id }) });
});

export default r;
