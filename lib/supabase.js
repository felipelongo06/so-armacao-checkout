/**
 * Supabase — sempre com a SERVICE ROLE KEY (server-side).
 * Nunca use a anon key aqui, e nunca exponha a service role no front.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = url && serviceKey
  ? createClient(url, serviceKey, { auth: { persistSession: false } })
  : null;

export function exigirSupabase() {
  if (!supabase) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY nao configuradas.');
  return supabase;
}
