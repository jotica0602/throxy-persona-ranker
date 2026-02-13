import {
  generateEmbedding,
  cosineSimilarity,
  parseProfileForEmbedding,
  computeLeadScore,
} from '@/lib/embeddings'
import type { EvalLead } from '@/lib/eval-set'
import { GoogleGenAI } from '@google/genai'

export type OptimizerProvider = 'gemini' | 'groq' | 'anthropic'

function getGemini(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is required.')
  return new GoogleGenAI({ apiKey })
}

/**
 * Spearman rank correlation between two rank arrays (1..N). Higher = better agreement.
 * Returns value in [-1, 1]. 1 = perfect agreement.
 */
export function spearmanCorrelation(ourRanks: number[], goldRanks: number[]): number {
  const n = ourRanks.length
  if (n !== goldRanks.length || n < 2) return 0
  const d = ourRanks.map((our, i) => our - goldRanks[i])
  const dSq = d.map((x) => x * x)
  const sumDSq = dSq.reduce((a, b) => a + b, 0)
  return 1 - (6 * sumDSq) / (n * (n * n - 1))
}

/**
 * Recall@k: fraction of gold top-k that appear in our top-k. 1 = all gold top-k are in our top-k.
 */
export function recallAtK(ourRanks: number[], goldRanks: number[], k: number): number {
  const n = ourRanks.length
  if (n < k || k < 1) return 0
  const goldTopK = new Set(
    goldRanks
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r - b.r)
      .slice(0, k)
      .map((x) => x.i)
  )
  const ourTopK = new Set(
    ourRanks
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r - b.r)
      .slice(0, k)
      .map((x) => x.i)
  )
  let hit = 0
  Array.from(goldTopK).forEach((i) => { if (ourTopK.has(i)) hit++ })
  return hit / k
}

/**
 * Mean reciprocal rank of gold top-3: average of 1/ourRank for each gold top-3 lead. Higher is better.
 */
export function mrrGoldTopK(ourRanks: number[], goldRanks: number[], k: number): number {
  const n = ourRanks.length
  if (n < k || k < 1) return 0
  const goldTopKIndices = goldRanks
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r - b.r)
    .slice(0, k)
    .map((x) => x.i)
  let sum = 0
  for (const i of goldTopKIndices) sum += 1 / ourRanks[i]
  return sum / k
}

const FEEDBACK_TOP_K = 5

/**
 * Builds a short feedback string for the optimizer: which gold top-k we ranked too low,
 * and which of our top-k are not in gold top-k. Helps the LLM adjust Target/Avoid/Prefer.
 */
export function buildRankingFeedback(
  evalLeads: EvalLead[],
  ourRanks: number[],
  goldRanks: number[]
): string {
  const n = evalLeads.length
  const k = Math.min(FEEDBACK_TOP_K, n)
  if (k < 1) return ''

  const goldTopIndices = goldRanks
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r - b.r)
    .slice(0, k)
    .map((x) => x.i)
  const ourTopIndices = ourRanks
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r - b.r)
    .slice(0, k)
    .map((x) => x.i)

  const label = (i: number) => {
    const lead = evalLeads[i].lead
    return `${lead['Full Name'] || 'Unknown'} (${lead['Company'] || 'Unknown'})`
  }

  const rankedTooLow: string[] = []
  for (const i of goldTopIndices) {
    if (ourRanks[i] > k) rankedTooLow.push(`${label(i)} — we ranked them ${ourRanks[i]}, gold top-${k}`)
  }
  const rankedTooHigh: string[] = []
  const goldTopSet = new Set(goldTopIndices)
  for (const i of ourTopIndices) {
    if (!goldTopSet.has(i)) rankedTooHigh.push(`${label(i)} — we put them in top-${k}, not in gold top-${k}`)
  }

  const parts: string[] = []
  if (rankedTooLow.length > 0) parts.push(`Gold top-${k} that we ranked too low: ${rankedTooLow.slice(0, 3).join('; ')}.`)
  if (rankedTooHigh.length > 0) parts.push(`Our top-${k} that should not be there: ${rankedTooHigh.slice(0, 3).join('; ')}.`)
  return parts.join(' ')
}

export interface EvalResult {
  /** Spearman correlation with gold ranking (main metric, -1 to 1). */
  score: number
  /** Fraction of gold top-5 that appear in our top-5. */
  recallAt5: number
  /** Mean reciprocal rank for gold top-3 (higher = better). */
  mrrTop3: number
  ourRanks: number[]
  goldRanks: number[]
}

/**
 * Evaluate a persona prompt on the evaluation set. Uses precomputed lead embeddings;
 * only embeds the persona (target/avoid/prefer). Returns Spearman, recall@5, MRR, and ranks.
 */
export async function evaluatePromptOnEvalSet(
  characteristics: string,
  evalLeads: EvalLead[],
  leadEmbeddings: number[][]
): Promise<EvalResult> {
  const { targetText, avoidText, preferText } = parseProfileForEmbedding(characteristics)
  if (!targetText || !targetText.trim()) {
    throw new Error('Profile cannot be empty.')
  }

  const targetEmbedding = await generateEmbedding(targetText)
  let avoidEmbedding: number[] | null = null
  let preferEmbedding: number[] | null = null
  if (avoidText) avoidEmbedding = await generateEmbedding(avoidText)
  if (preferText) preferEmbedding = await generateEmbedding(preferText)

  const hasAvoid = !!avoidEmbedding
  const hasPrefer = !!preferEmbedding

  const scored = evalLeads.map(({ lead }, i) => {
    const emb = leadEmbeddings[i]
    if (!emb?.length) return { lead, goldRank: evalLeads[i].goldRank, score: 0 }
    const simTarget = cosineSimilarity(targetEmbedding, emb)
    const simAvoid = avoidEmbedding ? cosineSimilarity(avoidEmbedding, emb) : 0
    const simPrefer = preferEmbedding ? cosineSimilarity(preferEmbedding, emb) : 0
    const score = computeLeadScore(simTarget, simAvoid, simPrefer, hasAvoid, hasPrefer)
    return { lead, goldRank: evalLeads[i].goldRank, score }
  })

  scored.sort((a, b) => b.score - a.score)
  const leadToOurRank = new Map<string, number>()
  scored.forEach((item, idx) => {
    const key = (item.lead['Full Name'] || '') + '|' + (item.lead['Company'] || '')
    leadToOurRank.set(key, idx + 1)
  })
  const ourRanks = evalLeads.map(({ lead }) => leadToOurRank.get((lead['Full Name'] || '') + '|' + (lead['Company'] || '')) ?? evalLeads.length + 1)
  const goldRanks = evalLeads.map((e) => e.goldRank)
  const score = spearmanCorrelation(ourRanks, goldRanks)
  const k5 = Math.min(5, evalLeads.length)
  const k3 = Math.min(3, evalLeads.length)
  return {
    score,
    recallAt5: k5 > 0 ? recallAtK(ourRanks, goldRanks, k5) : 0,
    mrrTop3: k3 > 0 ? mrrGoldTopK(ourRanks, goldRanks, k3) : 0,
    ourRanks,
    goldRanks,
  }
}

const OPTIMIZER_SYSTEM = `You are an expert at refining lead-profile prompts for a semantic ranking system. The system ranks leads by embedding similarity: it embeds Target (who we want), Avoid (who we exclude), and Prefer (what we prioritize), then scores each lead. Your goal is to refine the profile so that the resulting ranking order matches a gold standard as closely as possible.

How to improve the score (Spearman correlation with gold ranking, range -1 to 1; higher is better):
1. Target must describe the exact roles, company types, and criteria that characterize the gold top leads. Be specific: job titles, company size ranges, industry. The embedding model matches on meaning, so use the same vocabulary as the lead data (e.g. "VP Sales", "Head of SDR", "51-200 employees").
2. Avoid must explicitly list the types that appear in the gold bottom ranks or that we want to exclude. Strong Avoid criteria push bad matches down; vague Avoid does not help.
3. Prefer should capture distinguishing traits of the gold top (e.g. company size, industry focus) so that ties are broken in the right direction.
4. When you receive feedback about "ranked too low" or "ranked too high", adjust Target to include or exclude the traits of those leads. Add them to Avoid if they should rank low, or make Target more specific so they match better if they should rank high.

Rules:
- Preserve the user's intent and business context. Do not substitute a different business or persona.
- Always output exactly three sections: Target:, Avoid:, Prefer:. Use plain prose after each label; no markdown (no **, no -, no #).
- Output ONLY the refined profile. No preamble, no explanation.`

async function proposeImprovedPromptGemini(
  currentPrompt: string,
  currentScore: number,
  history: Array<{ prompt: string; score: number }>,
  requireDifferent?: boolean,
  feedback?: string
): Promise<string> {
  const historyText =
    history.length > 0
      ? '\nPrevious attempts (prompt -> score):\n' +
        history.map((h) => `Score ${h.score.toFixed(3)}:\n${h.prompt.slice(0, 500)}...`).join('\n---\n')
      : ''
  const diffHint = requireDifferent ? '\n\n[IMPORTANT: Output MUST be different. Refine or expand at least one of Target, Avoid, or Prefer while keeping the user\'s intent.]' : ''
  const feedbackBlock = feedback ? `\n\nRanking feedback (use this to adjust Target/Avoid/Prefer): ${feedback}` : ''
  const userContent = `Current profile — Spearman score: ${currentScore.toFixed(3)} (higher is better; 1 = perfect match to gold ranking).\n\n${currentPrompt}${historyText}${feedbackBlock}\n\nRefine the profile so the ranking better matches the gold order. Output only the refined profile: three sections "Target:", "Avoid:", "Prefer:" in plain text (no markdown).${diffHint}`
  const response = await getGemini().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: userContent,
    config: {
      systemInstruction: OPTIMIZER_SYSTEM,
      temperature: 0.65,
      maxOutputTokens: 900,
    },
  })
  const text = response.text?.trim() ?? ''
  return extractPromptOnly(text)
}

async function proposeImprovedPromptGroq(
  currentPrompt: string,
  currentScore: number,
  history: Array<{ prompt: string; score: number }>,
  requireDifferent?: boolean,
  feedback?: string
): Promise<string> {
  const historyText =
    history.length > 0
      ? '\nPrevious attempts (prompt -> score):\n' +
        history.map((h) => `Score ${h.score.toFixed(3)}:\n${h.prompt.slice(0, 500)}...`).join('\n---\n')
      : ''
  const diffHint = requireDifferent ? '\n\n[IMPORTANT: Output MUST be different. Refine or expand at least one of Target, Avoid, or Prefer while keeping the user\'s intent.]' : ''
  const feedbackBlock = feedback ? `\n\nRanking feedback (use this to adjust Target/Avoid/Prefer): ${feedback}` : ''
  const userContent = `Current profile — Spearman score: ${currentScore.toFixed(3)} (higher is better; 1 = perfect match to gold ranking).\n\n${currentPrompt}${historyText}${feedbackBlock}\n\nRefine the profile so the ranking better matches the gold order. Output only the refined profile: three sections "Target:", "Avoid:", "Prefer:" in plain text (no markdown).${diffHint}`
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: OPTIMIZER_SYSTEM },
        { role: 'user', content: userContent },
      ],
      temperature: 0.65,
      max_tokens: 900,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Groq API ${res.status}: ${err}`)
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content?.trim() ?? ''
  return extractPromptOnly(text)
}

async function proposeImprovedPromptAnthropic(
  currentPrompt: string,
  currentScore: number,
  history: Array<{ prompt: string; score: number }>,
  requireDifferent?: boolean,
  feedback?: string
): Promise<string> {
  const historyText =
    history.length > 0
      ? '\nPrevious attempts (prompt -> score):\n' +
        history.map((h) => `Score ${h.score.toFixed(3)}:\n${h.prompt.slice(0, 500)}...`).join('\n---\n')
      : ''
  const diffHint = requireDifferent ? '\n\n[IMPORTANT: Output MUST be different. Refine or expand at least one of Target, Avoid, or Prefer while keeping the user\'s intent.]' : ''
  const feedbackBlock = feedback ? `\n\nRanking feedback (use this to adjust Target/Avoid/Prefer): ${feedback}` : ''
  const userContent = `Current profile — Spearman score: ${currentScore.toFixed(3)} (higher is better; 1 = perfect match to gold ranking).\n\n${currentPrompt}${historyText}${feedbackBlock}\n\nRefine the profile so the ranking better matches the gold order. Output only the refined profile: three sections "Target:", "Avoid:", "Prefer:" in plain text (no markdown).${diffHint}`
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 900,
      system: OPTIMIZER_SYSTEM,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.65,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API ${res.status}: ${err}`)
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
  const text = data.content?.[0]?.text?.trim() ?? ''
  return extractPromptOnly(text)
}

function normalizePromptForCompare(p: string): string {
  return p.trim().replace(/\s+/g, ' ')
}

function isSamePrompt(a: string, b: string): boolean {
  return normalizePromptForCompare(a) === normalizePromptForCompare(b)
}

function extractPromptOnly(text: string): string {
  const trimmed = text.trim()
  const targetIdx = trimmed.search(/\bTarget\s*:/i)
  if (targetIdx >= 0) return trimmed.slice(targetIdx).trim()
  const firstLine = trimmed.split('\n')[0]?.trim() ?? ''
  if (firstLine.length > 50) return trimmed
  return trimmed
}

export async function proposeImprovedPrompt(
  currentPrompt: string,
  currentScore: number,
  history: Array<{ prompt: string; score: number }> = [],
  options?: { optimizerProvider?: OptimizerProvider; requireDifferent?: boolean; feedback?: string }
): Promise<string> {
  const provider = options?.optimizerProvider ?? 'gemini'
  const reqDiff = options?.requireDifferent ?? false
  const feedback = options?.feedback
  if (provider === 'groq') return proposeImprovedPromptGroq(currentPrompt, currentScore, history, reqDiff, feedback)
  if (provider === 'anthropic') return proposeImprovedPromptAnthropic(currentPrompt, currentScore, history, reqDiff, feedback)
  return proposeImprovedPromptGemini(currentPrompt, currentScore, history, reqDiff, feedback)
}

export interface OptimizationResult {
  bestPrompt: string
  bestScore: number
  history: Array<{ prompt: string; score: number }>
  iterations: number
}

/**
 * Run iterative prompt optimization: evaluate → LLM propose → evaluate; keep best.
 */
export async function runOptimization(options: {
  initialPrompt: string
  maxIterations: number
  evalLeads: EvalLead[]
  leadEmbeddings: number[][]
  optimizerProvider: OptimizerProvider
}): Promise<OptimizationResult> {
  const { initialPrompt, maxIterations, evalLeads, leadEmbeddings, optimizerProvider } = options
  let bestPrompt = initialPrompt
  let bestScore = -2
  const history: Array<{ prompt: string; score: number }> = []
  let currentPrompt = initialPrompt

  for (let iter = 0; iter < maxIterations; iter++) {
    const evalResult = await evaluatePromptOnEvalSet(currentPrompt, evalLeads, leadEmbeddings)
    const { score, ourRanks, goldRanks } = evalResult
    history.push({ prompt: currentPrompt, score })
    if (score > bestScore) {
      bestScore = score
      bestPrompt = currentPrompt
    }
    if (iter === maxIterations - 1) break
    const recentHistory = history.slice(-3)
    const feedback = buildRankingFeedback(evalLeads, ourRanks, goldRanks)
    let proposed = await proposeImprovedPrompt(currentPrompt, score, recentHistory, { optimizerProvider, feedback })
    if (isSamePrompt(proposed, currentPrompt)) {
      proposed = await proposeImprovedPrompt(currentPrompt, score, recentHistory, { optimizerProvider, requireDifferent: true, feedback })
    }
    if (!proposed || proposed.length < 20) {
      currentPrompt = bestPrompt
    } else {
      currentPrompt = proposed
    }
  }

  return { bestPrompt, bestScore, history, iterations: maxIterations }
}
