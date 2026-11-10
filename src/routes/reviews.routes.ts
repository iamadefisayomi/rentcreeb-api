import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { paginate, uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { notify } from '../services/notify';

const r = Router();
const SELECT = 'id, rating, comment, helpful_count, reply, replied_at, created_at, reviewer:profiles!reviews_reviewer_id_fkey(id, first_name, last_name, avatar_url)';

function summarize(ratings: number[]) {
  const total = ratings.length;
  const dist = [5, 4, 3, 2, 1].map((s) => ({ stars: s, percent: total ? Math.round((ratings.filter((x) => x === s).length / total) * 100) : 0 }));
  return { total, average: total ? +(ratings.reduce((a, b) => a + b, 0) / total).toFixed(1) : 0, distribution: dist };
}

async function list(column: 'property_id' | 'agent_id', id: string, query: unknown) {
  const { from, to, page, limit } = paginate(query);
  const { data } = await db.from('reviews').select(SELECT).eq(column, id).eq('hidden', false).order('created_at', { ascending: false }).range(from, to);
  const { data: all } = await db.from('reviews').select('rating').eq(column, id).eq('hidden', false);
  return { reviews: data, summary: summarize((all ?? []).map((x) => x.rating)), page, limit };
}

r.get('/property/:propertyId', async (req, res) => res.json(await list('property_id', req.params.propertyId, req.query)));
r.get('/agent/:agentId', async (req, res) => res.json(await list('agent_id', req.params.agentId, req.query)));

/** Reviews received by the logged-in agent/landlord (for responding). */
r.get('/received', authenticate, requireRole('agent', 'landlord', 'estate_manager'), async (req, res) =>
  res.json(await list('agent_id', req.user.id, req.query)));

/** Only verified tenants who completed an inspection of that property can review. */
r.post('/', authenticate, requireRole('tenant'), requireVerified, async (req, res) => {
  const b = z.object({ bookingId: uuid, rating: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }).parse(req.body);
  const { data: bk } = await db.from('bookings').select('*').eq('id', b.bookingId).eq('tenant_id', req.user.id).maybeSingle();
  if (!bk) throw notFound('Booking not found');
  if (bk.status !== 'completed') throw forbidden('You can review after your inspection is completed', 'REVIEW_NOT_ALLOWED');
  const { data: dup } = await db.from('reviews').select('id').eq('booking_id', bk.id).maybeSingle();
  if (dup) throw conflict('You already reviewed this inspection');
  const review = unwrap(await db.from('reviews').insert({
    property_id: bk.property_id, booking_id: bk.id, agent_id: bk.host_id, reviewer_id: req.user.id, rating: b.rating, comment: b.comment,
  }).select().single());
  await notify(bk.host_id, 'new_review', 'New review', `${b.rating}★ ${b.comment?.slice(0, 80) ?? ''}`, { reviewId: review.id });
  res.status(201).json({ review });
});

r.post('/:id/helpful', authenticate, async (req, res) => {
  const { data: have } = await db.from('review_helpful').select('review_id').eq('review_id', req.params.id).eq('user_id', req.user.id).maybeSingle();
  if (have) await db.from('review_helpful').delete().eq('review_id', req.params.id).eq('user_id', req.user.id);
  else await db.from('review_helpful').insert({ review_id: req.params.id, user_id: req.user.id });
  const { count } = await db.from('review_helpful').select('review_id', { count: 'exact', head: true }).eq('review_id', req.params.id);
  await db.from('reviews').update({ helpful_count: count ?? 0 }).eq('id', req.params.id);
  res.json({ helpful: !have, helpfulCount: count ?? 0 });
});

r.post('/:id/flag', authenticate, async (req, res) => {
  const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
  await db.from('review_flags').upsert({ review_id: req.params.id, user_id: req.user.id, reason });
  const { count } = await db.from('review_flags').select('review_id', { count: 'exact', head: true }).eq('review_id', req.params.id);
  await db.from('reviews').update({ flag_count: count ?? 0 }).eq('id', req.params.id);
  res.status(204).end();
});

r.post('/:id/reply', authenticate, requireRole('agent', 'landlord', 'estate_manager'), async (req, res) => {
  const { reply } = z.object({ reply: z.string().min(1).max(1000) }).parse(req.body);
  const { data: rv } = await db.from('reviews').select('agent_id, reviewer_id').eq('id', req.params.id).maybeSingle();
  if (!rv) throw notFound('Review not found');
  if (rv.agent_id !== req.user.id) throw forbidden();
  const updated = unwrap(await db.from('reviews').update({ reply, replied_at: new Date().toISOString() }).eq('id', req.params.id).select().single());
  await notify(rv.reviewer_id, 'review_reply', 'The agent replied to your review', reply.slice(0, 100));
  res.json({ review: updated });
});

export default r;
