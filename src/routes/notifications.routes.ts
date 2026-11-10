import { Router } from 'express';
import { db } from '../lib/supabase';
import { paginate } from '../lib/common';
import { authenticate } from '../middleware/auth';

const r = Router();
r.use(authenticate);

r.get('/', async (req, res) => {
  const { from, to } = paginate(req.query);
  const { data } = await db.from('notifications').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).range(from, to);
  const { count } = await db.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', req.user.id).is('read_at', null);
  res.json({ notifications: data, unreadCount: count ?? 0 });
});
r.post('/read-all', async (req, res) => {
  await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', req.user.id).is('read_at', null);
  res.status(204).end();
});
r.post('/:id/read', async (req, res) => {
  await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.user.id);
  res.status(204).end();
});

export default r;
