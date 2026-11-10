import { Router } from 'express';
import { z } from 'zod';
import { db, unwrap } from '../lib/supabase';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { kobo, paginate, uuid } from '../lib/common';
import { authenticate, requireRole, requireVerified } from '../middleware/auth';
import { deleteFromBunny } from '../lib/bunny';

const r = Router();
const LISTER_ROLES = ['agent', 'landlord', 'estate_manager'] as const;
const CARD = 'id, title, address, area, city, price_kobo, price_period, property_type, bedrooms, bathrooms, size_sqm, parking, is_verified, status, owner_id, property_media(url, media_type, position)';

const mediaItem = z.object({ url: z.string().url(), type: z.enum(['image', 'video']).default('image') });
const propertyBody = z.object({
  title: z.string().min(3), description: z.string().optional(), address: z.string().min(5),
  area: z.string().optional(), city: z.string().default('Lagos'), state: z.string().default('Lagos'),
  lat: z.number().optional(), lng: z.number().optional(),
  priceKobo: kobo, pricePeriod: z.enum(['year', 'month']).default('year'),
  propertyType: z.string().default('apartment'),
  bedrooms: z.number().int().min(0).default(0), bathrooms: z.number().int().min(0).default(0),
  sizeSqm: z.number().positive().optional(), parking: z.boolean().default(false),
  amenities: z.array(z.string()).default([]), inspectionFeeKobo: kobo.optional(),
  media: z.array(mediaItem).max(30).default([]),
  /** false = private/managed property (landlord tools only), never shown in search */
  publish: z.boolean().default(true),
});

const row = (b: z.infer<typeof propertyBody>) => ({
  title: b.title, description: b.description, address: b.address, area: b.area, city: b.city, state: b.state,
  lat: b.lat, lng: b.lng, price_kobo: b.priceKobo, price_period: b.pricePeriod, property_type: b.propertyType,
  bedrooms: b.bedrooms, bathrooms: b.bathrooms, size_sqm: b.sizeSqm, parking: b.parking, amenities: b.amenities,
  inspection_fee_kobo: b.inspectionFeeKobo,
});

async function assertOwner(propertyId: string, userId: string) {
  const { data } = await db.from('properties').select('*').eq('id', propertyId).maybeSingle();
  if (!data) throw notFound('Property not found');
  if (data.owner_id !== userId) throw forbidden('Not your property');
  return data;
}

/** Agents need an active subscription and must be within their plan's listing limit. */
async function assertCanList(user: Profile) {
  if (user.role !== 'agent') return;
  const { data: sub } = await db.from('subscriptions').select('*, subscription_plans(listing_limit)')
    .eq('agent_id', user.id).eq('status', 'active').gt('expires_at', new Date().toISOString()).maybeSingle();
  if (!sub) throw forbidden('An active subscription is required to list properties', 'SUBSCRIPTION_REQUIRED');
  const limit = (sub as any).subscription_plans.listing_limit;
  if (limit != null) {
    const { count } = await db.from('properties').select('id', { count: 'exact', head: true })
      .eq('owner_id', user.id).in('status', ['pending', 'approved']);
    if ((count ?? 0) >= limit) throw forbidden(`Your plan allows ${limit} listings. Upgrade to add more.`, 'LISTING_LIMIT_REACHED');
  }
}

// ── Search & discovery (public) ──
r.get('/', async (req, res) => {
  const { from, to, page, limit } = paginate(req.query);
  const q = z.object({
    q: z.string().optional(), area: z.string().optional(), type: z.string().optional(),
    minPrice: z.coerce.number().optional(), maxPrice: z.coerce.number().optional(),
    beds: z.coerce.number().optional(), baths: z.coerce.number().optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  }).parse(req.query);

  // Hide listings whose agent subscription has lapsed.
  const { data: lapsed } = await db.from('subscriptions').select('agent_id').eq('status', 'expired');
  const { data: active } = await db.from('subscriptions').select('agent_id').eq('status', 'active').gt('expires_at', new Date().toISOString());
  const activeSet = new Set((active ?? []).map((s) => s.agent_id));
  const hidden = [...new Set((lapsed ?? []).map((s) => s.agent_id))].filter((id) => !activeSet.has(id));

  let query = db.from('properties').select(CARD, { count: 'exact' }).eq('status', 'approved');
  if (hidden.length) query = query.not('owner_id', 'in', `(${hidden.join(',')})`);
  if (q.q) query = query.or(`title.ilike.%${q.q}%,address.ilike.%${q.q}%,area.ilike.%${q.q}%`);
  if (q.area) query = query.ilike('area', `%${q.area}%`);
  if (q.type) query = query.eq('property_type', q.type);
  if (q.minPrice) query = query.gte('price_kobo', q.minPrice);
  if (q.maxPrice) query = query.lte('price_kobo', q.maxPrice);
  if (q.beds) query = query.gte('bedrooms', q.beds);
  if (q.baths) query = query.gte('bathrooms', q.baths);
  query = q.sort === 'price_asc' ? query.order('price_kobo') : q.sort === 'price_desc' ? query.order('price_kobo', { ascending: false }) : query.order('created_at', { ascending: false });

  const { data, count, error } = await query.range(from, to);
  if (error) throw badRequest(error.message);
  res.json({ properties: data, page, limit, total: count ?? 0 });
});

// ── Static paths before /:id ──
r.get('/mine', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const { data } = await db.from('properties').select(CARD).eq('owner_id', req.user.id).neq('status', 'archived').order('created_at', { ascending: false });
  res.json({ properties: data });
});

r.get('/saved', authenticate, async (req, res) => {
  const { data } = await db.from('saved_properties').select(`created_at, properties(${CARD})`).eq('user_id', req.user.id).order('created_at', { ascending: false });
  res.json({ properties: (data ?? []).map((d: any) => d.properties) });
});

r.post('/', authenticate, requireRole(...LISTER_ROLES), requireVerified, async (req, res) => {
  const b = propertyBody.parse(req.body);
  if (b.publish) await assertCanList(req.user);
  const p = unwrap(await db.from('properties').insert({ ...row(b), owner_id: req.user.id, status: b.publish ? 'pending' : 'unlisted' }).select().single());
  if (b.media.length)
    await db.from('property_media').insert(b.media.map((m, i) => ({ property_id: p.id, url: m.url, media_type: m.type, position: i })));
  res.status(201).json({ property: p, message: b.publish ? 'Submitted for approval' : 'Property saved' });
});

// ── Detail ──
r.get('/:id', async (req, res) => {
  const { data: p } = await db.from('properties').select('*, property_media(id, url, media_type, position), nearby_places(*)').eq('id', req.params.id).maybeSingle();
  if (!p || !['approved', 'rented'].includes(p.status)) throw notFound('Property not found');

  const [owner, listings, stats, similar] = await Promise.all([
    db.from('profiles').select('id, first_name, last_name, avatar_url, role, rating_avg, rating_count, nin_verified, created_at').eq('id', p.owner_id).single(),
    db.from('properties').select('id', { count: 'exact', head: true }).eq('owner_id', p.owner_id).eq('status', 'approved'),
    db.from('reviews').select('rating').eq('property_id', p.id).eq('hidden', false),
    db.from('properties').select(CARD).eq('status', 'approved').neq('id', p.id)
      .or(`area.eq.${p.area ?? ''},property_type.eq.${p.property_type}`).limit(8),
  ]);
  const ratings = (stats.data ?? []).map((x) => x.rating);
  res.json({
    property: { ...p, property_media: (p.property_media ?? []).sort((a: any, b: any) => a.position - b.position) },
    agent: { ...owner.data, listingsCount: listings.count ?? 0 },
    reviewsSummary: { count: ratings.length, average: ratings.length ? +(ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0 },
    similar: similar.data,
  });
});

r.get('/:id/nearby', async (req, res) => {
  const { category } = z.object({ category: z.string().optional() }).parse(req.query);
  let q = db.from('nearby_places').select('*').eq('property_id', req.params.id).order('distance_km');
  if (category) q = q.eq('category', category);
  res.json({ places: (await q).data });
});

// ── Owner management ──
r.patch('/:id', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const existing = await assertOwner(req.params.id, req.user.id);
  const b = propertyBody.partial().omit({ media: true, publish: true }).parse(req.body);
  const patch: Record<string, unknown> = Object.fromEntries(Object.entries(row(b as any)).filter(([, v]) => v !== undefined));
  patch.updated_at = new Date().toISOString();
  if (existing.status === 'rejected') { patch.status = 'pending'; patch.rejection_reason = null; } // edit & resubmit
  res.json({ property: unwrap(await db.from('properties').update(patch).eq('id', existing.id).select().single()) });
});

r.post('/:id/submit', authenticate, requireRole(...LISTER_ROLES), requireVerified, async (req, res) => {
  const p = await assertOwner(req.params.id, req.user.id);
  if (p.status !== 'unlisted') throw badRequest('Only unlisted properties can be submitted');
  await assertCanList(req.user);
  await db.from('properties').update({ status: 'pending' }).eq('id', p.id);
  res.json({ message: 'Submitted for approval' });
});

r.delete('/:id', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(req.params.id, req.user.id);
  await db.from('properties').update({ status: 'archived' }).eq('id', p.id);
  res.status(204).end();
});

r.post('/:id/media', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  const p = await assertOwner(req.params.id, req.user.id);
  const { media } = z.object({ media: z.array(mediaItem).min(1).max(30) }).parse(req.body);
  const { count } = await db.from('property_media').select('id', { count: 'exact', head: true }).eq('property_id', p.id);
  const rows = media.map((m, i) => ({ property_id: p.id, url: m.url, media_type: m.type, position: (count ?? 0) + i }));
  res.status(201).json({ media: unwrap(await db.from('property_media').insert(rows).select()) });
});

r.delete('/:id/media/:mediaId', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  await assertOwner(req.params.id, req.user.id);
  const { data } = await db.from('property_media').delete().eq('id', req.params.mediaId).eq('property_id', req.params.id).select().maybeSingle();
  if (data) await deleteFromBunny(data.url);
  res.status(204).end();
});

r.post('/:id/nearby', authenticate, requireRole(...LISTER_ROLES), async (req, res) => {
  await assertOwner(req.params.id, req.user.id);
  const { places } = z.object({ places: z.array(z.object({
    category: z.enum(['education', 'healthcare', 'transport', 'markets', 'religious', 'security', 'utilities']),
    name: z.string(), distanceKm: z.number().positive(), rating: z.number().min(0).max(5).optional(),
  })).min(1) }).parse(req.body);
  const rows = places.map((p) => ({ property_id: req.params.id, category: p.category, name: p.name, distance_km: p.distanceKm, rating: p.rating }));
  res.status(201).json({ places: unwrap(await db.from('nearby_places').insert(rows).select()) });
});

// ── Saved ──
r.post('/:id/save', authenticate, async (req, res) => {
  await db.from('saved_properties').upsert({ user_id: req.user.id, property_id: uuid.parse(req.params.id) });
  res.status(204).end();
});
r.delete('/:id/save', authenticate, async (req, res) => {
  await db.from('saved_properties').delete().eq('user_id', req.user.id).eq('property_id', req.params.id);
  res.status(204).end();
});

export default r;
