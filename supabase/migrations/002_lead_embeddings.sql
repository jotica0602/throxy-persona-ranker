-- Persist embeddings for leads so we only compute them at ingest time.
-- Existing rows will have embedding = null until re-ingested.

alter table public.leads
  add column if not exists embedding jsonb;

comment on column public.leads.embedding is 'Precomputed embedding vector (array of numbers) from the same model used for ranking.';
