import { NextRequest, NextResponse } from 'next/server'
import { loadEvalSet } from '@/lib/eval-set'
import { generateEmbeddingBatch, leadToText } from '@/lib/embeddings'
import { runOptimization, type OptimizerProvider } from '@/lib/prompt-optimizer'

const DEFAULT_MAX_ITERATIONS = 4

/**
 * POST /api/prompt-optimize
 * Body: { initialPrompt: string (required), maxIterations?: number }
 * Uses evaluation set (50 pre-ranked leads) to optimize the persona prompt via an LLM agent.
 * Returns { bestPrompt, bestScore, history, iterations }.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const rawPrompt = typeof body.initialPrompt === 'string' ? body.initialPrompt.trim() : ''
    if (!rawPrompt) {
      return NextResponse.json(
        { error: 'Profile text is required. Enter your ideal profile in the text area and try again.' },
        { status: 400 }
      )
    }
    const initialPrompt = rawPrompt
    const maxIterations =
      typeof body.maxIterations === 'number' && body.maxIterations >= 1 && body.maxIterations <= 10
        ? body.maxIterations
        : DEFAULT_MAX_ITERATIONS

    const evalLeads = await loadEvalSet()
    if (evalLeads.length < 5) {
      return NextResponse.json(
        { error: 'Evaluation set has too few ranked leads. Need at least 5.' },
        { status: 400 }
      )
    }

    // Optimizer uses only Gemini, Groq, or Anthropic (no OpenAI).
    const hasGemini = !!process.env.GEMINI_API_KEY?.trim()
    const hasGroq = !!process.env.GROQ_API_KEY?.trim()
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY?.trim()
    let optimizerProvider: OptimizerProvider
    if (hasGemini) {
      optimizerProvider = 'gemini'
    } else if (hasGroq) {
      optimizerProvider = 'groq'
    } else if (hasAnthropic) {
      optimizerProvider = 'anthropic'
    } else {
      return NextResponse.json(
        {
          error:
            'Prompt optimization needs one of: GEMINI_API_KEY (aistudio.google.com/apikey), GROQ_API_KEY (console.groq.com, free tier), or ANTHROPIC_API_KEY. Add one to .env.local and restart the dev server.',
        },
        { status: 500 }
      )
    }

    const leadTexts = evalLeads.map((e) => leadToText(e.lead))
    // Embed in small chunks to avoid Hugging Face timeouts (ETIMEDOUT) on slow networks
    const EMBED_CHUNK_SIZE = 12
    const leadEmbeddings: number[][] = []
    for (let i = 0; i < leadTexts.length; i += EMBED_CHUNK_SIZE) {
      const chunk = leadTexts.slice(i, i + EMBED_CHUNK_SIZE)
      let chunkEmbeddings: number[][]
      try {
        chunkEmbeddings = await generateEmbeddingBatch(chunk)
      } catch (chunkErr) {
        const isTimeout = /timeout|ETIMEDOUT|terminated/i.test(chunkErr instanceof Error ? chunkErr.message : String(chunkErr))
        if (isTimeout && chunk.length > 1) {
          // Retry one text at a time for this chunk
          chunkEmbeddings = []
          for (const text of chunk) {
            const one = await generateEmbeddingBatch([text])
            chunkEmbeddings.push(...one)
          }
        } else {
          throw chunkErr
        }
      }
      leadEmbeddings.push(...chunkEmbeddings)
    }
    if (leadEmbeddings.length !== evalLeads.length) {
      return NextResponse.json(
        { error: 'Failed to compute embeddings for all evaluation leads.' },
        { status: 500 }
      )
    }

    const result = await runOptimization({
      initialPrompt,
      maxIterations,
      evalLeads,
      leadEmbeddings,
      optimizerProvider,
    })

    return NextResponse.json({
      bestPrompt: result.bestPrompt,
      bestScore: result.bestScore,
      history: result.history,
      iterations: result.iterations,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ENOENT') || msg.includes('eval_set')) {
      return NextResponse.json(
        { error: 'Evaluation set file not found. Ensure data/eval/eval_set.csv exists.' },
        { status: 404 }
      )
    }
    const errObj = err && typeof err === 'object' ? (err as { code?: string; status?: number; cause?: Error }) : {}
    const isQuota =
      errObj.code === 'insufficient_quota' ||
      errObj.status === 429 ||
      /quota|429|insufficient_quota/i.test(msg)
    const isTimeout =
      errObj.code === 'ETIMEDOUT' ||
      /timeout|ETIMEDOUT|terminated/i.test(msg) ||
      (errObj.cause && /ETIMEDOUT/i.test(String(errObj.cause)))
    if (isQuota) {
      return NextResponse.json(
        {
          error:
            'Rate limit or quota exceeded. Try GROQ (free tier): get a key at console.groq.com and add GROQ_API_KEY to .env.local, then restart the dev server. Or use ANTHROPIC_API_KEY.',
        },
        { status: 503 }
      )
    }
    if (isTimeout) {
      return NextResponse.json(
        {
          error:
            'Embedding request timed out (Hugging Face can be slow). Try again; if it keeps failing, set AI_PROVIDER=gemini and GEMINI_API_KEY for faster embeddings.',
        },
        { status: 504 }
      )
    }
    console.error('Prompt optimize error:', err)
    return NextResponse.json(
      { error: msg || 'Prompt optimization failed.' },
      { status: 500 }
    )
  }
}
