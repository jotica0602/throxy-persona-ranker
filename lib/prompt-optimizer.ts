import {
  generateEmbedding,
  cosineSimilarity,
  leadToText,
  parseProfileForEmbedding,
  AVOID_PENALTY_WEIGHT,
  PREFER_BONUS_WEIGHT,
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
 * Evaluate a persona prompt on the evaluation set. Uses precomputed lead embeddings;
 * only embeds the persona (target/avoid/prefer). Returns Spearman correlation with gold ranking.
 */
export async function evaluatePromptOnEvalSet(
  characteristics: string,
  evalLeads: EvalLead[],
  leadEmbeddings: number[][]
): Promise<{ score: number; ourRanks: number[] }> {
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
    const rawScore = simTarget - AVOID_PENALTY_WEIGHT * simAvoid + PREFER_BONUS_WEIGHT * simPrefer
    const normalizedScore =
      hasAvoid || hasPrefer
        ? Math.max(0, Math.min(1, (rawScore + 1.35) / 2.6))
        : (simTarget + 1) / 2
    return { lead, goldRank: evalLeads[i].goldRank, score: normalizedScore }
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
  return { score, ourRanks }
}

const OPTIMIZER_SYSTEM = `You help users define and refine their ideal lead profile for ranking. The profile describes their company type and who they want to reach.

The user may give you free-form text: a few words, a paragraph, or already structured with Target/Avoid/Prefer. Your job is to identify what they are looking for (Target), what they want to avoid (Avoid), and what they prefer (Prefer), then output a refined profile with those three sections clearly filled. If the user did not mention avoid or prefer, infer from context when possible or leave those sections concise; Target is required and must capture who they want to reach.

Do not replace their criteria with a different business or generic template. Improve by:
1. Keeping their meaning: same type of company, same kind of targets/avoid/prefer they described or implied.
2. Being more explicit: list concrete job titles and company sizes (e.g. "2-10 employees", "51-200") where it fits their intent.
3. Always output exactly three sections: Target:, Avoid:, Prefer: — add missing roles or criteria they implied; if they said nothing about avoid or prefer, write a short line (e.g. "None specified.") or infer from context.
4. Using wording that matches how leads are usually described (job title, company, size) so the ranking model can match better.

The evaluation score (Spearman, -1 to 1) measures how well the prompt aligns with a gold ranking; higher is better. Your refined prompt should preserve the user's definition of target/avoid/prefer and make it more explicit so it can score higher.

OUTPUT FORMAT (strict — you must follow this exactly):
- Output ONLY the refined profile. No preamble, no "Here is...", no explanation.
- Use plain text only. Do NOT use markdown: no asterisks (**bold**), no bullet dashes (-), no hash headers (#).
- Use exactly these three section labels at the start of a line: "Target:", "Avoid:", "Prefer:"
- After each label, write the content in plain prose. Use commas, "and", "or" for lists. Each section may be multiple lines.
- Example format:

Target: Vice Presidents of Operations, Technical Directors, and similar senior leadership roles responsible for infrastructure or technical leadership in companies in solar or wind energy, with 11-500 employees.
Avoid: Companies in the traditional fossil-fuel sector such as oil and gas, coal mining, consulting firms advising energy companies, and very early-stage startups under 10 employees. Also exclude energy trading and renewable investment firms that do not operate infrastructure.
Prefer: Companies with 51-200 employees, actively running commercial-scale renewable infrastructure such as solar farms or wind turbines, with a focus on operational deployment and grid stability rather than research and development.`

async function proposeImprovedPromptGemini(
  currentPrompt: string,
  currentScore: number,
  history: Array<{ prompt: string; score: number }>,
  requireDifferent?: boolean
): Promise<string> {
  const historyText =
    history.length > 0
      ? '\nPrevious attempts (prompt -> score):\n' +
        history.map((h) => `Score ${h.score.toFixed(3)}:\n${h.prompt.slice(0, 500)}...`).join('\n---\n')
      : ''
  const diffHint = requireDifferent ? '\n\n[IMPORTANT: Output MUST be different. Refine or expand at least one of Target, Avoid, or Prefer while keeping the user\'s intent.]' : ''
  const userContent = `Current profile (score: ${currentScore.toFixed(3)}):\n${currentPrompt}${historyText}\n\nIdentify the key parts (who they want — Target, who to exclude — Avoid, what to prefer — Prefer) and output a refined profile with exactly "Target:", "Avoid:", "Prefer:" as section labels. Use plain text only (no markdown, no ** or - bullets).${diffHint}`
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
  requireDifferent?: boolean
): Promise<string> {
  const historyText =
    history.length > 0
      ? '\nPrevious attempts (prompt -> score):\n' +
        history.map((h) => `Score ${h.score.toFixed(3)}:\n${h.prompt.slice(0, 500)}...`).join('\n---\n')
      : ''
  const diffHint = requireDifferent ? '\n\n[IMPORTANT: Output MUST be different. Refine or expand at least one of Target, Avoid, or Prefer while keeping the user\'s intent.]' : ''
  const userContent = `Current profile (score: ${currentScore.toFixed(3)}):\n${currentPrompt}${historyText}\n\nIdentify the key parts (who they want — Target, who to exclude — Avoid, what to prefer — Prefer) and output a refined profile with exactly "Target:", "Avoid:", "Prefer:" as section labels. Use plain text only (no markdown, no ** or - bullets).${diffHint}`
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
  requireDifferent?: boolean
): Promise<string> {
  const historyText =
    history.length > 0
      ? '\nPrevious attempts (prompt -> score):\n' +
        history.map((h) => `Score ${h.score.toFixed(3)}:\n${h.prompt.slice(0, 500)}...`).join('\n---\n')
      : ''
  const diffHint = requireDifferent ? '\n\n[IMPORTANT: Output MUST be different. Refine or expand at least one of Target, Avoid, or Prefer while keeping the user\'s intent.]' : ''
  const userContent = `Current profile (score: ${currentScore.toFixed(3)}):\n${currentPrompt}${historyText}\n\nIdentify the key parts (who they want — Target, who to exclude — Avoid, what to prefer — Prefer) and output a refined profile with exactly "Target:", "Avoid:", "Prefer:" as section labels. Use plain text only (no markdown, no ** or - bullets).${diffHint}`
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
  options?: { optimizerProvider?: OptimizerProvider; requireDifferent?: boolean }
): Promise<string> {
  const provider = options?.optimizerProvider ?? 'gemini'
  const reqDiff = options?.requireDifferent ?? false
  if (provider === 'groq') return proposeImprovedPromptGroq(currentPrompt, currentScore, history, reqDiff)
  if (provider === 'anthropic') return proposeImprovedPromptAnthropic(currentPrompt, currentScore, history, reqDiff)
  return proposeImprovedPromptGemini(currentPrompt, currentScore, history, reqDiff)
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
    const { score } = await evaluatePromptOnEvalSet(currentPrompt, evalLeads, leadEmbeddings)
    history.push({ prompt: currentPrompt, score })
    if (score > bestScore) {
      bestScore = score
      bestPrompt = currentPrompt
    }
    if (iter === maxIterations - 1) break
    const recentHistory = history.slice(-3)
    let proposed = await proposeImprovedPrompt(currentPrompt, score, recentHistory, { optimizerProvider })
    if (isSamePrompt(proposed, currentPrompt)) {
      proposed = await proposeImprovedPrompt(currentPrompt, score, recentHistory, { optimizerProvider, requireDifferent: true })
    }
    if (!proposed || proposed.length < 20) {
      currentPrompt = bestPrompt
    } else {
      currentPrompt = proposed
    }
  }

  return { bestPrompt, bestScore, history, iterations: maxIterations }
}
