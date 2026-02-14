import { getSupabase, EVAL_EMBEDDINGS_TABLE } from '@/lib/supabase'
import type { EvalLead } from '@/lib/eval-set'

function leadKey(lead: Record<string, string>): string {
  const fullName = (lead['Full Name'] ?? '').trim()
  const company = (lead['Company'] ?? '').trim()
  return `${fullName}|${company}`
}

export interface EvalEmbeddingsLoadResult {
  /** Embeddings in the same order as evalLeads; null if we need to compute (missing or not configured). */
  embeddings: number[][] | null
  /** True when all rows were found in the DB. */
  fromCache: boolean
}

/**
 * Load precomputed eval lead embeddings from Supabase.
 * Returns embeddings in the same order as evalLeads if every row exists; otherwise embeddings is null.
 */
export async function loadEvalEmbeddingsFromSupabase(
  evalLeads: EvalLead[]
): Promise<EvalEmbeddingsLoadResult> {
  try {
    const supabase = getSupabase()
    const { data: rows, error } = await supabase
      .from(EVAL_EMBEDDINGS_TABLE)
      .select('full_name, company, embedding')
    if (error) {
      // Table might not exist yet
      if (error.code === '42P01' || error.message?.toLowerCase().includes('does not exist')) {
        return { embeddings: null, fromCache: false }
      }
      throw error
    }
    const byKey = new Map<string, number[]>()
    for (const row of rows ?? []) {
      const key = `${(row.full_name ?? '').trim()}|${(row.company ?? '').trim()}`
      const emb = row.embedding
      if (Array.isArray(emb) && emb.length > 0) {
        byKey.set(key, emb as number[])
      }
    }
    const embeddings: number[][] = []
    for (const { lead } of evalLeads) {
      const emb = byKey.get(leadKey(lead))
      if (!emb) return { embeddings: null, fromCache: false }
      embeddings.push(emb)
    }
    return { embeddings, fromCache: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Supabase is not configured')) {
      return { embeddings: null, fromCache: false }
    }
    throw e
  }
}

/**
 * Store eval lead embeddings in Supabase (upsert by full_name + company).
 * Call after computing embeddings so the next prompt-optimize run can use the cache.
 */
export async function storeEvalEmbeddingsInSupabase(
  evalLeads: EvalLead[],
  embeddings: number[][]
): Promise<void> {
  if (evalLeads.length !== embeddings.length) {
    throw new Error('evalLeads and embeddings length mismatch')
  }
  const supabase = getSupabase()
  const rows = evalLeads.map(({ lead, goldRank }, i) => ({
    full_name: (lead['Full Name'] ?? '').trim(),
    company: (lead['Company'] ?? '').trim(),
    gold_rank: goldRank,
    embedding: embeddings[i] ?? [],
    updated_at: new Date().toISOString(),
  }))
  const { error } = await supabase
    .from(EVAL_EMBEDDINGS_TABLE)
    .upsert(rows, { onConflict: 'full_name,company' })
  if (error) throw error
}
