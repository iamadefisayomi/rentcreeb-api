import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { kobo, uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { createPayment } from '../services/payments';
import { notify } from '../services/notify';

const r = Router();
r.use(authenticate);
const MANAGERS = ['landlord', 'estate_manager'] as const;
const SELECT = '*, properties(id, title, address, area), tenant:profiles!tenancies_tenant_id_fkey(id, first_name, last_name, phone, email, avatar_url)';

async function getTenancy(id: string, userId: string) {
  const { data } = await db.from('tenancies').select(SELECT).eq('id', id).maybeSingle();
  if (!data) throw notFound('Tenancy not found');
  if (![data.landlord_id, data.tenant_id].includes(userId)) throw forbidden();
  return data as any;
}

/** Landlord/estate manager: attach an existing RentCreeb user (by email) to a property as a tenant. */
r.post('/', requireRole(...MANAGERS), requireVerified, async (req, res) => {
  const b = z.object({
    propertyId: uuid, tenantEmail: z.string().email().toLowerCase(), unitLabel: z.string().optional(),
    leaseStart: z.string().date(), leaseEnd: z.string().date().optional(), rentKobo: kobo,
    frequency: z.enum(['monthly', 'quarterly', 'yearly']).default('yearly'), firstDueDate: z.string().date().optional(),
  }).parse(req.body);
  const { data: prop } = await db.from('properties').select('owner_id').eq('id', b.propertyId).maybeSingle();
  if (!prop || prop.owner_id !== req.user.id) throw forbidden('Not your property');
  const { data: tenant } = await db.from('profiles').select('id, role').eq('email', b.tenantEmail).maybeSingle();
  if (!tenant) throw notFound('No RentCreeb account with that email. Ask the tenant to sign up first.');
  if (tenant.role !== 'tenant') throw badRequest('That account is not a tenant');

  const due = b.firstDueDate ?? b.leaseStart;
  const t = unwrap(await db.from('tenancies').insert({
    property_id: b.propertyId, landlord_id: req.user.id, tenant_id: tenant.id, unit_label: b.unitLabel,
    lease_start: b.leaseStart, lease_end: b.leaseEnd, rent_kobo: b.rentKobo, frequency: b.frequency, next_due_date: due,
  }).select().single());
  await db.from('rent_payments').insert({ tenancy_id: t.id, amount_kobo: b.rentKobo, due_date: due });
  await notify(tenant.id, 'tenancy_added', 'You were added to a property', 'Track your rent in your dashboard.', { tenancyId: t.id });
  res.status(201).json({ tenancy: t });
});

r.get('/', async (req, res) => {
  const col = req.user.role === 'tenant' ? 'tenant_id' : 'landlord_id';
  res.json({ tenancies: (await db.from('tenancies').select(SELECT).eq(col, req.user.id).order('created_at', { ascending: false })).data });
});

r.get('/:id', async (req, res) => {
  const t = await getTenancy(req.params.id, req.user.id);
  const { data: payments } = await db.from('rent_payments').select('*').eq('tenancy_id', t.id).order('due_date', { ascending: false });
  res.json({ tenancy: t, rentPayments: payments });
});

r.patch('/:id', requireRole(...MANAGERS), async (req, res) => {
  const t = await getTenancy(req.params.id, req.user.id);
  if (t.landlord_id !== req.user.id) throw forbidden();
  const b = z.object({ leaseEnd: z.string().date().optional(), status: z.enum(['active', 'ended']).optional(), unitLabel: z.string().optional() }).parse(req.body);
  res.json({ tenancy: unwrap(await db.from('tenancies').update({ lease_end: b.leaseEnd, status: b.status, unit_label: b.unitLabel }).eq('id', t.id).select().single()) });
});

/** Tenant pays the currently due rent via Paystack; landlord wallet is credited on success. */
r.post('/:id/pay-rent', requireRole('tenant'), requireVerified, async (req, res) => {
  const t = await getTenancy(req.params.id, req.user.id);
  if (t.tenant_id !== req.user.id || t.status !== 'active') throw forbidden();
  const { data: due } = await db.from('rent_payments').select('*').eq('tenancy_id', t.id).in('status', ['due', 'overdue']).order('due_date').limit(1).maybeSingle();
  if (!due) throw badRequest('No rent currently due', 'NOTHING_DUE');
  const payment = await createPayment(req.user, 'rent', Number(due.amount_kobo), { tenancy_id: t.id, rent_payment_id: due.id });
  res.status(201).json({ payment, rentPayment: due });
});

export default r;
