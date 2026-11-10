import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest } from '../lib/errors';
import { uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';

const r = Router();
r.use(authenticate);

/** "Report Agent" after an inspection. */
r.post('/', requireRole('tenant'), requireVerified, async (req, res) => {
  const b = z.object({ bookingId: uuid, reason: z.string().min(3), details: z.string().max(2000).optional() }).parse(req.body);
  const { data: bk } = await db.from('bookings').select('host_id').eq('id', b.bookingId).eq('tenant_id', req.user.id).maybeSingle();
  if (!bk) throw badRequest('Booking not found');
  res.status(201).json({ report: unwrap(await db.from('reports').insert({
    reporter_id: req.user.id, agent_id: bk.host_id, booking_id: b.bookingId, reason: b.reason, details: b.details }).select().single()) });
});

r.get('/mine', async (req, res) =>
  res.json({ reports: (await db.from('reports').select('*').eq('reporter_id', req.user.id).order('created_at', { ascending: false })).data }));

export default r;
