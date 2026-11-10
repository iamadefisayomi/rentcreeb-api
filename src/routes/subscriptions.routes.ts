import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { uuid } from '../lib/common';
import { notFound } from '../lib/errors';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { createPayment } from '../services/payments';

const r = Router();

r.get('/plans', async (_req, res) =>
  res.json({ plans: (await db.from('subscription_plans').select('*').eq('active', true).order('price_kobo')).data }));

r.get('/current', authenticate, requireRole('agent'), async (req, res) => {
  const { data } = await db.from('subscriptions').select('*, subscription_plans(*)').eq('agent_id', req.user.id)
    .in('status', ['active', 'expired']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const active = !!data && data.status === 'active' && new Date(data.expires_at) > new Date();
  res.json({ subscription: data, active });
});

/** Pay via Paystack → webhook activates the plan. */
r.post('/checkout', authenticate, requireRole('agent'), requireVerified, async (req, res) => {
  const { planId } = z.object({ planId: uuid }).parse(req.body);
  const { data: plan } = await db.from('subscription_plans').select('*').eq('id', planId).eq('active', true).maybeSingle();
  if (!plan) throw notFound('Plan not found');
  const sub = unwrap(await db.from('subscriptions').insert({ agent_id: req.user.id, plan_id: plan.id }).select().single());
  const payment = await createPayment(req.user, 'subscription', Number(plan.price_kobo), { subscription_id: sub.id });
  res.status(201).json({ subscription: sub, payment });
});

export default r;
