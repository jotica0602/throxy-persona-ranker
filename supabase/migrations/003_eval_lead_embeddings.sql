-- Eval set lead embeddings: one row per eval lead, keyed by Full Name + Company
-- so we don't re-embed the same eval set on every prompt optimization.
-- Run in Supabase SQL Editor (or via CLI) after 001_leads and 002_lead_embeddings.

create table if not exists public.eval_lead_embeddings (
  full_name text not null,
  company text not null,
  gold_rank integer not null,
  embedding jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (full_name, company)
);

comment on table public.eval_lead_embeddings is 'Precomputed embeddings for eval set leads (same model as ranking). Loaded by prompt-optimize to avoid re-embedding on every run.';
comment on column public.eval_lead_embeddings.full_name is 'Lead Full Name from eval_set.csv';
comment on column public.eval_lead_embeddings.company is 'Lead Company from eval_set.csv';
comment on column public.eval_lead_embeddings.gold_rank is 'Gold rank 1..N from eval set order';
comment on column public.eval_lead_embeddings.embedding is 'Embedding vector (array of numbers) from the same model used for ranking.';

-- RLS
alter table public.eval_lead_embeddings enable row level security;

create policy "Service role full access on eval_lead_embeddings"
  on public.eval_lead_embeddings
  for all
  to service_role
  using (true)
  with check (true);
