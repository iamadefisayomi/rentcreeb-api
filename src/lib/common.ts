import { z } from 'zod';

export const normalizePhone = (raw: string) => {
  const d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+234')) return d;
  if (d.startsWith('234')) return '+' + d;
  if (d.startsWith('0')) return '+234' + d.slice(1);
  return d.startsWith('+') ? d : '+234' + d;
};

export const phoneSchema = z
  .string()
  .transform(normalizePhone)
  .refine((p) => /^\+234[789][01]\d{8}$/.test(p), 'Enter a valid Nigerian phone number');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/\d/, 'Include a number')
  .regex(/[^A-Za-z0-9]/, 'Include a symbol');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export function paginate(query: unknown) {
  const { page, limit } = paginationSchema.parse(query);
  return { page, limit, from: (page - 1) * limit, to: (page - 1) * limit + limit - 1 };
}

export const uuid = z.string().uuid();
export const kobo = z.number().int().positive();

export const fullName = (p: { first_name?: string | null; last_name?: string | null }) =>
  [p.first_name, p.last_name].filter(Boolean).join(' ');

export const pct = (amount: number, percent: number) => Math.round((amount * percent) / 100);

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = (x: number) => (x * Math.PI) / 180;
  const a =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
export function addInterval(date: Date, freq: 'monthly' | 'quarterly' | 'yearly') {
  const d = new Date(date);
  d.setMonth(d.getMonth() + (freq === 'monthly' ? 1 : freq === 'quarterly' ? 3 : 12));
  return d;
}

/** Accepts true/false or 'true'/'false' (query strings & multipart fields). z.coerce.boolean() would treat 'false' as true. */
export const boolish = z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')]);
