import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if ((url || serviceKey) && (!url || !serviceKey)) {
  console.warn('LROS: Supabase is partially configured. Set both NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to use the database.')
}

/**
 * Server-side Supabase client (service role). Use for ingest and rank-from-DB.
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.
 */
export function getSupabase() {
  if (!url || !serviceKey) {
    throw new Error(
      'Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local, then restart the dev server (Ctrl+C, then npm run dev).'
    )
  }
  return createClient(url, serviceKey)
}

export const LEADS_TABLE = 'leads'
export const EVAL_EMBEDDINGS_TABLE = 'eval_lead_embeddings'