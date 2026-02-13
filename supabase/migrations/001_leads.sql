-- LROS: leads table for persona ranking (Throxy challenge)
-- Run this in Supabase SQL Editor or via Supabase CLI to create the table.

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null,
  created_at timestamptz not null default now()
);

-- Optional: index for ordering by created_at if you ingest in batches
create index if not exists leads_created_at_idx on public.leads (created_at desc);

-- RLS: allow service role full access; no anon access by default
alter table public.leads enable row level security;

create policy "Service role can do anything"
  on public.leads
  for all
  to service_role
  using (true)
  with check (true);
