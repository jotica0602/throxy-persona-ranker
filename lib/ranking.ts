import {
  generateEmbedding,
  generateEmbeddingBatch,
  cosineSimilarity,
  leadToText,
  parseProfileForEmbedding,
  AVOID_PENALTY_WEIGHT,
  PREFER_BONUS_WEIGHT,
} from '@/lib/embeddings'

export interface RankedLeadResult {
  lead: Record<string, string>
  score: number
  similarity: number
  rank: number
}

const TOP_N = 10
const MIN_SCORE = 0.3

/**
 * Rank a list of leads against a persona spec (Target / Avoid / Prefer).
 * Reusable for both CSV upload and database-backed ranking.
 */
export async function rankLeadsAgainstPersona(
  leads: Record<string, string>[],
  characteristics: string,
  options?: { topN?: number; maxLeads?: number; leadEmbeddings?: number[][] }
): Promise<{ rankedLeads: RankedLeadResult[]; totalProcessed: number; totalMatched: number }> {
  const { targetText, avoidText, preferText } = parseProfileForEmbedding(characteristics)
  if (!targetText || !targetText.trim()) {
    throw new Error('Profile cannot be empty.')
  }

  const targetEmbedding = await generateEmbedding(targetText)
  let avoidEmbedding: number[] | null = null
  let preferEmbedding: number[] | null = null
  if (avoidText) avoidEmbedding = await generateEmbedding(avoidText)
  if (preferText) preferEmbedding = await generateEmbedding(preferText)

  let slice = leads
  const envMax = process.env.MAX_LEADS ? Math.max(1, parseInt(String(process.env.MAX_LEADS), 10) || 0) : undefined
  const maxLeads = options?.maxLeads ?? envMax
  if (maxLeads !== undefined && leads.length > maxLeads) {
    slice = leads.slice(0, maxLeads)
  }

  let allEmbeddings: number[][]
  if (options?.leadEmbeddings && options.leadEmbeddings.length === slice.length) {
    allEmbeddings = options.leadEmbeddings
  } else {
    const leadTexts = slice.map((lead) => leadToText(lead))
    allEmbeddings = await generateEmbeddingBatch(leadTexts)
  }
  const hasAvoid = !!avoidEmbedding
  const hasPrefer = !!preferEmbedding

  const scored = slice.map((lead, i) => {
    const simTarget = cosineSimilarity(targetEmbedding, allEmbeddings[i])
    const simAvoid = avoidEmbedding ? cosineSimilarity(avoidEmbedding, allEmbeddings[i]) : 0
    const simPrefer = preferEmbedding ? cosineSimilarity(preferEmbedding, allEmbeddings[i]) : 0
    const rawScore = simTarget - AVOID_PENALTY_WEIGHT * simAvoid + PREFER_BONUS_WEIGHT * simPrefer
    const normalizedScore =
      hasAvoid || hasPrefer
        ? Math.max(0, Math.min(1, (rawScore + 1.35) / 2.6))
        : (simTarget + 1) / 2
    return { lead, score: normalizedScore, similarity: simTarget }
  })

  scored.sort((a, b) => b.score - a.score)
  const topN = options?.topN ?? TOP_N
  const ranked = scored.slice(0, topN).map((item, index) => ({
    lead: item.lead,
    score: item.score,
    similarity: item.similarity,
    rank: index + 1,
  }))
  const filtered = ranked.filter((item) => item.score >= MIN_SCORE)

  return {
    rankedLeads: filtered,
    totalProcessed: slice.length,
    totalMatched: filtered.length,
  }
}
