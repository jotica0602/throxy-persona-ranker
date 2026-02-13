/**
 * Ensures the public.leads table (and embedding column) exist.
 * Uses DATABASE_URL (Postgres connection string) from env.
 * Call before ingest or rank/db so the table is created automatically.
 * Use Supabase → Database → Connection string in "Session" or "Direct" mode (not Transaction).
 */
const MIGRATION_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS public.leads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS leads_created_at_idx ON public.leads (created_at DESC)`,
  `ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS "Service role full access" ON public.leads`,
  `DROP POLICY IF EXISTS "Service role can do anything" ON public.leads`,
  `CREATE POLICY "Service role full access" ON public.leads FOR ALL TO service_role USING (true) WITH CHECK (true)`,
  `ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS embedding jsonb`,
]

let ensured = false

/** Call this when Supabase returns an error; if it's "table not found", returns a message for the user. */
export function getTableMissingMessage(supabaseErrorMessage: string): string | null {
  const lower = supabaseErrorMessage.toLowerCase()
  if (
    lower.includes('could not find the table') ||
    (lower.includes('relation') && lower.includes('does not exist')) ||
    lower.includes('schema cache')
  ) {
    return (
      "La tabla 'leads' no existe en Supabase. " +
      "Añade DATABASE_URL en .env.local (Supabase → Project Settings → Database → Connection string, modo Session o Direct, no Transaction), " +
      "reinicia el servidor (npm run dev) y vuelve a intentar para crearla automáticamente. " +
      "O créala a mano: en Supabase → SQL Editor ejecuta los archivos en supabase/migrations/."
    )
  }
  return null
}

export async function ensureLeadsTable(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    return
  }
  if (ensured) {
    return
  }
  const { Client } = await import('pg')
  const maxTries = 2
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 20000 })
    try {
      await client.connect()
      for (const sql of MIGRATION_STATEMENTS) {
        await client.query(sql)
      }
      ensured = true
      return
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : ''
      const msg = err instanceof Error ? err.message : String(err)
      const retryable =
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNREFUSED' ||
        /timeout expired/i.test(msg)
      if (retryable && attempt < maxTries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt))
        continue
      }
      throw err
    } finally {
      await client.end().catch(() => {})
    }
  }
}
