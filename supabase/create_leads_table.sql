CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_created_at_idx ON public.leads (created_at DESC);

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON public.leads;
DROP POLICY IF EXISTS "Service role can do anything" ON public.leads;
CREATE POLICY "Service role full access"
  ON public.leads FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Columna para guardar los embeddings
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS embedding jsonb;
