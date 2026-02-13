import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'

const PROVIDER = (process.env.AI_PROVIDER || 'huggingface').toLowerCase()

const HF_EMBED_MODEL = process.env.HF_EMBED_MODEL || 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
const HF_EMBED_BATCH_SIZE = 32
/** Direct Inference API URL to avoid SDK provider resolution (which can timeout). */
const HF_INFERENCE_URL = process.env.HF_INFERENCE_URL || 'https://router.huggingface.co'
const HF_FETCH_TIMEOUT_MS = 90_000

function getHuggingFaceToken(): string {
  const token = process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN
  if (!token) {
    throw new Error('HUGGINGFACE_TOKEN (or HF_TOKEN) is not configured. Get a token at https://huggingface.co/settings/tokens')
  }
  return token
}

let _openai: OpenAI | null = null
let _gemini: GoogleGenAI | null = null

function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not configured. Please set the environment variable.')
    }
    _openai = new OpenAI({ apiKey })
  }
  return _openai
}

function getGemini(): GoogleGenAI {
  if (!_gemini) {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured. Please set the environment variable.')
    }
    _gemini = new GoogleGenAI({ apiKey })
  }
  return _gemini
}


/**
 * Convierte un lead en un texto estructurado para embeddings (rol y empresa primero para mejor matching).
 */
export function leadToText(lead: Record<string, string>): string {
  const getFieldValue = (possibleFields: string[]): string => {
    for (const field of possibleFields) {
      const value = lead[field] || lead[field.toLowerCase()] || lead[field.toUpperCase()]
      if (value && value.trim()) {
        return value
      }
    }
    return ''
  }

  const parts: string[] = []
  const title = getFieldValue(['lead_job_title', 'Title', 'title'])
  const company = getFieldValue(['account_name', 'Company', 'company'])
  const industry = getFieldValue(['account_industry', 'Industry', 'industry'])
  const employeeRange = getFieldValue(['account_employee_range', 'Employee Range', 'employee_range'])

  if (title) parts.push(`Role: ${title}`)
  if (company) parts.push(`Company: ${company}`)
  if (industry) parts.push(`Industry: ${industry}`)
  if (employeeRange) parts.push(`Company size: ${employeeRange}`)

  const fullName = getFieldValue(['Full Name', 'full_name'])
  const firstName = getFieldValue(['lead_first_name'])
  const lastName = getFieldValue(['lead_last_name'])
  if (fullName) {
    parts.push(`Name: ${fullName}`)
  } else if (firstName || lastName) {
    parts.push(`Name: ${firstName} ${lastName}`.trim())
  }

  const domain = getFieldValue(['account_domain', 'domain'])
  if (domain) parts.push(`Domain: ${domain}`)

  const shownKeys = new Set([
    'Full Name', 'full_name', 'lead_first_name', 'lead_last_name',
    'lead_job_title', 'Title', 'title',
    'account_name', 'Company', 'company',
    'account_industry', 'Industry', 'industry',
    'account_employee_range', 'Employee Range', 'employee_range',
    'account_domain', 'domain', 'LI', 'linkedin', 'LinkedIn', 'Rank'
  ])

  Object.entries(lead).forEach(([key, value]) => {
    if (value && value.trim() && !shownKeys.has(key) && !shownKeys.has(key.toLowerCase())) {
      parts.push(`${key}: ${value}`)
    }
  })

  return parts.length ? `Lead. ${parts.join('. ')}` : 'Lead.'
}

/** Peso con el que se penaliza la similitud a "Avoid" (0 = no penalizar). */
export const AVOID_PENALTY_WEIGHT = 0.35

/** Peso con el que se premia la similitud a "Prefer" (ej. small companies → priorizar rangos pequeños). */
export const PREFER_BONUS_WEIGHT = 0.25

/**
 * Strip common markdown from text (e.g. optimizer output): **bold**, - bullets, # headers.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[\s]*[-*]\s+/gm, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * Separa el texto del perfil en "target", "avoid" y "prefer".
 * Acepta secciones multilínea. Soporta texto con markdown residual y lo limpia.
 */
export function parseProfileForEmbedding(characteristics: string): {
  targetText: string
  avoidText: string | null
  preferText: string | null
} {
  const trimmed = characteristics.trim()

  const extractSection = (fromLabel: string): string => {
    const re = new RegExp(`\\b${fromLabel}\\s*:\\s*([\\s\\S]*?)(?=\\b(Target|Avoid|Prefer)\\s*:|$)`, 'i')
    const m = trimmed.match(re)
    if (!m || !m[1]) return ''
    return stripMarkdown(m[1].trim())
  }

  const hasStructuredSections =
    trimmed.search(/\bTarget\s*:/i) >= 0 ||
    trimmed.search(/\bAvoid\s*:/i) >= 0 ||
    trimmed.search(/\bPrefer\s*:/i) >= 0

  const targetRaw = extractSection('Target')
  const avoidRaw = trimmed.search(/\bAvoid\s*:/i) >= 0 ? extractSection('Avoid') : null
  const preferRaw = trimmed.search(/\bPrefer\s*:/i) >= 0 ? extractSection('Prefer') : null

  if (!hasStructuredSections && trimmed.length > 0) {
    return {
      targetText: `Target profile: ${stripMarkdown(trimmed)}`,
      avoidText: null,
      preferText: null,
    }
  }

  return {
    targetText: targetRaw ? `Target profile: ${targetRaw}` : targetRaw || '',
    avoidText: avoidRaw ? `Profiles to avoid: ${avoidRaw}` : null,
    preferText: preferRaw ? `Profiles we prefer: ${preferRaw}` : null,
  }
}

/**
 * Genera un embedding para un texto dado (OpenAI)
 */
async function generateEmbeddingOpenAI(text: string): Promise<number[]> {
  const response = await getOpenAI().embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  })
  return response.data[0].embedding
}

/** Recursively get the first array of numbers (embedding vector) at any depth. */
function extractEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === 'number') return value as number[]
    if (value.length > 0) return extractEmbedding(value[0])
  }
  return null
}

/** Normalize HF feature-extraction output to a single embedding (number[]). */
function normalizeHfEmbedding(out: unknown): number[] {
  if (!out || !Array.isArray(out)) throw new Error('Hugging Face returned no embedding')
  // Single input can return: [[...]], [...], or [[[...]]] (token-level)
  const emb = extractEmbedding(out) ?? extractEmbedding(out[0])
  if (emb?.length) return emb
  throw new Error('Hugging Face returned unexpected embedding format')
}

/** Normalize HF feature-extraction output to array of embeddings. */
function normalizeHfEmbeddingBatch(out: unknown, expectedLen: number): number[][] {
  if (!Array.isArray(out)) {
    throw new Error(`Hugging Face returned invalid response, expected ${expectedLen} embeddings`)
  }
  const result: number[][] = []
  for (let i = 0; i < out.length; i++) {
    const emb = extractEmbedding(out[i])
    if (emb?.length) result.push(emb)
    else result.push([])
  }
  if (result.length !== expectedLen) {
    throw new Error(`Hugging Face returned ${result.length} embeddings, expected ${expectedLen}`)
  }
  return result
}

/**
 * Hugging Face Inference API via direct fetch.
 * Router (router.huggingface.co) uses path: /hf-inference/models/{model}/pipeline/feature-extraction
 */
async function hfFetchEmbeddings(inputs: string | string[]): Promise<unknown> {
  const token = getHuggingFaceToken()
  const base = HF_INFERENCE_URL.replace(/\/$/, '')
  const modelPath = encodeURIComponent(HF_EMBED_MODEL)
  const url = `${base}/hf-inference/models/${modelPath}/pipeline/feature-extraction`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), HF_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Hugging Face API ${res.status}: ${text || res.statusText}`)
    }
    return await res.json()
  } catch (err) {
    clearTimeout(timeoutId)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Hugging Face request timed out. Try again or set HF_INFERENCE_URL / use another provider.')
    }
    throw err
  }
}

async function generateEmbeddingHuggingFace(text: string): Promise<number[]> {
  const result = await hfFetchEmbeddings(text)
  return normalizeHfEmbedding(result)
}

/**
 * Genera un embedding para un texto dado (Google Gemini). Reintenta en 429.
 */
async function generateEmbeddingGemini(text: string): Promise<number[]> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_EMBED_RETRIES; attempt++) {
    try {
      const response = await getGemini().models.embedContent({
        model: 'gemini-embedding-001',
        contents: text,
        config: { taskType: 'SEMANTIC_SIMILARITY' },
      })
      const values = response.embeddings?.[0]?.values
      if (!values || values.length === 0) {
        throw new Error('Gemini returned no embedding')
      }
      return values
    } catch (err) {
      lastErr = err
      if (attempt < MAX_EMBED_RETRIES && isRateLimitError(err)) {
        const waitMs = parseRetryAfterMs(err)
        console.log(`Embedding rate limit (429). Waiting ${waitMs / 1000}s before retry (attempt ${attempt + 1}/${MAX_EMBED_RETRIES})...`)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

/** Batch size for Gemini to stay under 100 requests/min (each batch = 1 request) */
const GEMINI_EMBED_BATCH_SIZE = 50

const MAX_EMBED_RETRIES = 5
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000
const MAX_RATE_LIMIT_WAIT_MS = 120_000

/** Parse "Please retry in 58.015976945s" from Gemini 429 error message. Returns ms. */
function parseRetryAfterMs(error: unknown): number {
  const msg = error instanceof Error ? error.message : String(error)
  const match = msg.match(/[Rr]etry in ([\d.]+)s/)
  if (match) {
    const sec = parseFloat(match[1])
    const ms = Math.ceil(sec * 1000)
    return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(5_000, ms))
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS
}

function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')
}

/** User-friendly message when quota is exceeded (e.g. daily 1000 limit). */
function getQuotaErrorMessage(error: unknown): string | null {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes('PerDay') || msg.includes('1000') && msg.includes('quota')) {
    return 'Límite diario de embeddings alcanzado (1000/día en plan gratuito). Vuelve a intentarlo mañana o reduce el número de leads en el CSV.'
  }
  return null
}

/**
 * Genera embeddings para varios textos en una sola llamada (Gemini).
 * Reintenta con espera si la API devuelve 429 (límite de cuota).
 */
async function generateEmbeddingBatchGemini(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_EMBED_RETRIES; attempt++) {
    try {
      const response = await getGemini().models.embedContent({
        model: 'gemini-embedding-001',
        contents: texts,
        config: { taskType: 'SEMANTIC_SIMILARITY' },
      })
      const embeddings = (response.embeddings ?? []).map((e) => e.values ?? [])
      if (embeddings.length !== texts.length) {
        throw new Error(`Gemini returned ${embeddings.length} embeddings, expected ${texts.length}`)
      }
      return embeddings
    } catch (err) {
      lastErr = err
      if (attempt < MAX_EMBED_RETRIES && isRateLimitError(err)) {
        const waitMs = parseRetryAfterMs(err)
        console.log(`Embedding rate limit (429). Waiting ${waitMs / 1000}s before retry (attempt ${attempt + 1}/${MAX_EMBED_RETRIES})...`)
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

/**
 * Genera embeddings para varios textos (OpenAI permite batch nativo).
 */
async function generateEmbeddingBatchOpenAI(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const response = await getOpenAI().embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  })
  return response.data.map((d) => d.embedding)
}

/**
 * Genera embeddings por lotes (Hugging Face Inference API directa).
 */
async function generateEmbeddingBatchHuggingFace(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const results: number[][] = []
  for (let i = 0; i < texts.length; i += HF_EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + HF_EMBED_BATCH_SIZE)
    const result = await hfFetchEmbeddings(batch)
    results.push(...normalizeHfEmbeddingBatch(result, batch.length))
  }
  return results
}

/**
 * Genera un embedding para un texto dado (provider from AI_PROVIDER)
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    if (PROVIDER === 'gemini') {
      return await generateEmbeddingGemini(text)
    }
    if (PROVIDER === 'huggingface') {
      return await generateEmbeddingHuggingFace(text)
    }
    return await generateEmbeddingOpenAI(text)
  } catch (error) {
    console.error('Error generating embedding:', error)
    const friendly = getQuotaErrorMessage(error)
    throw new Error(friendly || 'Failed to generate embedding: ' + (error instanceof Error ? error.message : 'Unknown error'))
  }
}

/**
 * Genera embeddings por lotes. Con Gemini reduce las peticiones para respetar
 * el límite de 100 req/min del free tier.
 */
export async function generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  try {
    if (PROVIDER === 'huggingface') {
      return await generateEmbeddingBatchHuggingFace(texts)
    }
    if (PROVIDER === 'gemini') {
      const results: number[][] = []
      for (let i = 0; i < texts.length; i += GEMINI_EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + GEMINI_EMBED_BATCH_SIZE)
        const batchResults = await generateEmbeddingBatchGemini(batch)
        results.push(...batchResults)
        // Pausa entre lotes para no saturar cuota (100/min y 1000/día)
        if (i + GEMINI_EMBED_BATCH_SIZE < texts.length) {
          await new Promise((r) => setTimeout(r, 2500))
        }
      }
      return results
    }
    return await generateEmbeddingBatchOpenAI(texts)
  } catch (error) {
    console.error('Error generating embedding batch:', error)
    const friendly = getQuotaErrorMessage(error)
    throw new Error(friendly || 'Failed to generate embeddings: ' + (error instanceof Error ? error.message : 'Unknown error'))
  }
}

/**
 * Calcula la similitud coseno entre dos vectores de embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length')
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  normA = Math.sqrt(normA)
  normB = Math.sqrt(normB)

  if (normA === 0 || normB === 0) {
    return 0
  }

  return dotProduct / (normA * normB)
}

const EXPLANATION_SYSTEM = 'You are an expert assistant in lead analysis. Your task is to explain concisely and clearly why a lead is relevant based on the desired characteristics. Respond in English, 2-3 sentences maximum.'

/**
 * Genera una explicación usando LLM (OpenAI)
 */
async function generateExplanationOpenAI(
  lead: Record<string, string>,
  characteristics: string,
  similarityScore: number
): Promise<string> {
  const leadText = leadToText(lead)
  const response = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: EXPLANATION_SYSTEM },
      {
        role: 'user',
        content: `Desired lead characteristics: "${characteristics}"

Lead information:
${leadText}

Similarity score: ${(similarityScore * 100).toFixed(1)}%

Explain briefly why this lead is relevant to the desired characteristics.`,
      },
    ],
    temperature: 0.7,
    max_tokens: 150,
  })
  return response.choices[0]?.message?.content || 'Could not generate explanation'
}

/**
 * Genera una explicación usando LLM (Google Gemini)
 */
async function generateExplanationGemini(
  lead: Record<string, string>,
  characteristics: string,
  similarityScore: number
): Promise<string> {
  const leadText = leadToText(lead)
  const userContent = `Desired lead characteristics: "${characteristics}"

Lead information:
${leadText}

Similarity score: ${(similarityScore * 100).toFixed(1)}%

Explain briefly why this lead is relevant to the desired characteristics.`

  const response = await getGemini().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: userContent,
    config: {
      systemInstruction: EXPLANATION_SYSTEM,
      temperature: 0.7,
      maxOutputTokens: 150,
    },
  })
  const text = response.text
  return (text && text.trim()) ? text : 'Could not generate explanation'
}

/**
 * Genera una explicación usando LLM sobre por qué un lead es relevante
 */
export async function generateExplanation(
  lead: Record<string, string>,
  characteristics: string,
  similarityScore: number
): Promise<string> {
  try {
    if (PROVIDER === 'gemini') {
      return await generateExplanationGemini(lead, characteristics, similarityScore)
    }
    return await generateExplanationOpenAI(lead, characteristics, similarityScore)
  } catch (error) {
    console.error('Error generating explanation:', error)
    return 'Failed to generate explanation'
  }
}
