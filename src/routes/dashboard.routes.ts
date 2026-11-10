import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/supabase';
import { authenticate, requireRole } from '../middleware/auth';

const r = Router();
r.use(authenticate);

const sum = (rows: any[] | null, f: (x: any) => number) => (rows ?? []).reduce((s, x) => s + f(x), 0);
const monthKey = (d: string) => d.slice(0, 7);
function lastMonths(n: number) {
  return Array.from({ length: n }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (n - 1 - i)); return d.toISOString().slice(0, 7); });
}
const monthStart = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.toISOString(); };

/** Tenant: rent tracking, savings overview, open maintenance, recent transactions. */
r.get('/tenant', requireRole('tenant'), async (req, res) => {
  const [tenancies, plans, maint, tx] = await Promise.all([
    db.from('tenancies').select('*, properties(title, address), rent_payments(id, amount_kobo, due_date, status)').eq('tenant_id', req.user.id).eq('status', 'active'),
    db.from('rentsave_plans').select('*').eq('tenant_id', req.user.id).neq('status', 'paused'),
    db.from('maintenance_requests').select('id, category, status, created_at').eq('tenant_id', req.user.id).in('status', ['open', 'job_posted', 'in_progress']),
    db.from('payments').select('id, purpose, amount_kobo, status, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(5),
  ]);
  res.json({
    rent: (tenancies.data ?? []).map((t: any) => ({
      tenancyId: t.id, property: t.properties, rentKobo: t.rent_kobo, nextDueDate: t.next_due_date,
      due: (t.rent_payments ?? []).filter((p: any) => p.status !== 'paid').sort((a: any, b: any) => a.due_date.localeCompare(b.due_date))[0] ?? null })),
    savings: { totalSavedKobo: sum(plans.data, (p) => Number(p.saved_kobo)), plans: plans.data },
    openMaintenance: maint.data, recentTransactions: tx.data,
  });
});

/** Landlord / estate manager: units, tenants, payments, tickets. */
r.get('/landlord', requireRole('landlord', 'estate_manager'), async (req, res) => {
  const [props, tenancies, maint] = await Promise.all([
    db.from('properties').select('id, status').eq('owner_id', req.user.id).neq('status', 'archived'),
    db.from('tenancies').select('id, tenant_id, rent_kobo, rent_payments(status, amount_kobo, due_date)').eq('landlord_id', req.user.id).eq('status', 'active'),
    db.from('maintenance_requests').select('id, status').eq('landlord_id', req.user.id).in('status', ['open', 'job_posted', 'in_progress']),
  ]);
  const rp = (tenancies.data ?? []).flatMap((t: any) => t.rent_payments ?? []);
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    units: props.data?.length ?? 0, activeTenants: tenancies.data?.length ?? 0,
    rentCollectedKobo: sum(rp.filter((p: any) => p.status === 'paid'), (p) => Number(p.amount_kobo)),
    rentOutstandingKobo: sum(rp.filter((p: any) => p.status !== 'paid' && p.due_date <= today), (p) => Number(p.amount_kobo)),
    openMaintenanceTickets: maint.data?.length ?? 0,
  });
});

/** Financial reports: rent by month, outstanding, repair spend. ?months=6 */
r.get('/landlord/reports', requireRole('landlord', 'estate_manager'), async (req, res) => {
  const { months } = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).parse(req.query);
  const keys = lastMonths(months);
  const since = `${keys[0]}-01`;
  const { data: ten } = await db.from('tenancies').select('id').eq('landlord_id', req.user.id);
  const ids = (ten ?? []).map((t) => t.id);
  const { data: rent } = ids.length ? await db.from('rent_payments').select('amount_kobo, paid_at').in('tenancy_id', ids).eq('status', 'paid').gte('paid_at', since) : { data: [] as any[] };
  const { data: repairs } = await db.from('escrows').select('amount_kobo, created_at, jobs!inner(landlord_id)').eq('kind', 'job').eq('jobs.landlord_id', req.user.id).gte('created_at', since);
  res.json({ months: keys.map((m) => ({
    month: m,
    rentCollectedKobo: sum((rent ?? []).filter((p: any) => monthKey(p.paid_at) === m), (p) => Number(p.amount_kobo)),
    repairSpendKobo: sum((repairs ?? []).filter((p: any) => monthKey(p.created_at) === m), (p) => Number(p.amount_kobo)),
  })) });
});

/** Agent: bookings, revenue, properties, subscription. */
r.get('/agent', requireRole('agent', 'landlord', 'estate_manager'), async (req, res) => {
  const [bk, props, esc, sub, wallet] = await Promise.all([
    db.from('bookings').select('id, status, scheduled_at').eq('host_id', req.user.id),
    db.from('properties').select('id, status').eq('owner_id', req.user.id).neq('status', 'archived'),
    db.from('escrows').select('amount_kobo, fee_kobo, status').eq('payee_id', req.user.id).eq('kind', 'inspection'),
    db.from('subscriptions').select('status, expires_at, subscription_plans(name, listing_limit)').eq('agent_id', req.user.id).eq('status', 'active').maybeSingle(),
    db.from('wallets').select('available_kobo').eq('user_id', req.user.id).single(),
  ]);
  const b = bk.data ?? [];
  res.json({
    revenueKobo: sum((esc.data ?? []).filter((e) => e.status === 'released'), (e) => Number(e.amount_kobo) - Number(e.fee_kobo)),
    pendingRevenueKobo: sum((esc.data ?? []).filter((e) => e.status === 'held'), (e) => Number(e.amount_kobo) - Number(e.fee_kobo)),
    walletKobo: wallet.data?.available_kobo ?? 0,
    bookings: { total: b.length, upcoming: b.filter((x) => x.status === 'confirmed').length, completed: b.filter((x) => x.status === 'completed').length, awaitingOtp: b.filter((x) => x.status === 'paid').length },
    listings: { total: props.data?.length ?? 0, approved: props.data?.filter((p) => p.status === 'approved').length ?? 0, pending: props.data?.filter((p) => p.status === 'pending').length ?? 0, rejected: props.data?.filter((p) => p.status === 'rejected').length ?? 0 },
    subscription: sub.data, rating: { average: req.user.rating_avg, count: req.user.rating_count },
  });
});

/** Revenue & performance analytics. ?months=6 */
r.get('/agent/analytics', requireRole('agent', 'landlord', 'estate_manager'), async (req, res) => {
  const { months } = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).parse(req.query);
  const keys = lastMonths(months);
  const since = `${keys[0]}-01`;
  const [bk, esc, props] = await Promise.all([
    db.from('bookings').select('status, created_at, property_id').eq('host_id', req.user.id).gte('created_at', since),
    db.from('escrows').select('amount_kobo, fee_kobo, released_at').eq('payee_id', req.user.id).eq('kind', 'inspection').eq('status', 'released').gte('released_at', since),
    db.from('properties').select('id, title').eq('owner_id', req.user.id),
  ]);
  const b = bk.data ?? [];
  const perProperty = (props.data ?? []).map((p) => ({ propertyId: p.id, title: p.title, bookings: b.filter((x) => x.property_id === p.id).length })).sort((x, y) => y.bookings - x.bookings).slice(0, 5);
  res.json({
    series: keys.map((m) => ({ month: m,
      bookings: b.filter((x) => monthKey(x.created_at) === m).length,
      completed: b.filter((x) => x.status === 'completed' && monthKey(x.created_at) === m).length,
      revenueKobo: sum((esc.data ?? []).filter((e) => monthKey(e.released_at) === m), (e) => Number(e.amount_kobo) - Number(e.fee_kobo)) })),
    conversionRate: b.length ? +(b.filter((x) => x.status === 'completed').length / b.length * 100).toFixed(1) : 0,
    topProperties: perProperty, rating: { average: req.user.rating_avg, count: req.user.rating_count },
  });
});

/** Artisan dashboard + earnings screen. */
r.get('/artisan', requireRole('artisan'), async (req, res) => {
  const [ap, wallet, esc, jobs, wtx, alerts] = await Promise.all([
    db.from('artisan_profiles').select('review_status, skill_category').eq('user_id', req.user.id).maybeSingle(),
    db.from('wallets').select('available_kobo').eq('user_id', req.user.id).single(),
    db.from('escrows').select('amount_kobo, fee_kobo, status, released_at, jobs(title, properties(area))').eq('payee_id', req.user.id).eq('kind', 'job'),
    db.from('jobs').select('id, title, status, started_at, properties(title, area)').eq('artisan_id', req.user.id),
    db.from('wallet_transactions').select('amount_kobo, created_at').eq('user_id', req.user.id).eq('kind', 'escrow_release').gte('created_at', `${lastMonths(6)[0]}-01`),
    db.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);
  const e = esc.data ?? [];
  const released = e.filter((x) => x.status === 'released');
  const net = (x: any) => Number(x.amount_kobo) - Number(x.fee_kobo);
  const j = jobs.data ?? [];
  res.json({
    reviewStatus: ap.data?.review_status, rating: { average: req.user.rating_avg, count: req.user.rating_count },
    earnings: {
      totalKobo: sum(released, net),
      thisMonthKobo: sum(released.filter((x) => x.released_at >= monthStart()), net),
      escrowKobo: sum(e.filter((x) => x.status === 'held'), net),
      walletKobo: wallet.data?.available_kobo ?? 0, jobsDone: j.filter((x) => x.status === 'completed').length,
      monthly: lastMonths(6).map((m) => ({ month: m, kobo: sum((wtx.data ?? []).filter((t) => monthKey(t.created_at) === m), (t) => Number(t.amount_kobo)) })),
      recent: e.sort((a, b) => (b.released_at ?? '').localeCompare(a.released_at ?? '')).slice(0, 10),
    },
    activeJobs: j.filter((x) => ['assigned', 'diagnosing', 'awaiting_approval', 'approved', 'in_progress', 'awaiting_confirmation'].includes(x.status)),
    awaitingResponse: (await db.from('job_quotes').select('id', { count: 'exact', head: true }).eq('artisan_id', req.user.id).eq('status', 'pending')).count ?? 0,
    openJobsCount: alerts.count ?? 0,
  });
});

export default r;
