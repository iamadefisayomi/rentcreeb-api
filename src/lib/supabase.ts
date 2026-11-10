import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { HttpError } from './errors';

const opts = { auth: { persistSession: false, autoRefreshToken: false } };

/** Service-role client: bypasses RLS. Server-side only. */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opts);

/** Fresh anon client per call (sign-in/refresh mutate client session state). */
export const anonClient = () => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, opts);

export function unwrap<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new HttpError(500, r.error.message, 'DB_ERROR');
  return r.data as T;
}
