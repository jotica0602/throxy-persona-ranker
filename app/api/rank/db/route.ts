import { NextRequest, NextResponse } from 'next/server'
import { getSupabase, LEADS_TABLE } from '@/lib/supabase'
import { ensureLeadsTable, getTableMissingMessage } from '@/lib/db-migrate'
import { rankLeadsAgainstPersona } from '@/lib/ranking'
import { parseProfileForEmbedding } from '@/lib/embeddings'

/**
 * Run the AI ranking process against leads stored in the database.
 * POST body: JSON { characteristics: string } (persona spec with Target / Avoid / Prefer).
 * Optional: { maxLeads?: number } to limit how many leads to load from DB.
 * Creates the leads table automatically if DATABASE_URL is set.
 */
export async function POST(request: NextRequest) {
  try {
    await ensureLeadsTable()
    const supabase = getSupabase()
    const body = await request.json().catch(() => ({}))
    const characteristics = typeof body.characteristics === 'string' ? body.characteristics : ''
    const maxLeads = typeof body.maxLeads === 'number' ? body.maxLeads : undefined

    if (!characteristics.trim()) {
      return NextResponse.json(
        { error: 'Please provide characteristics (persona spec) in the request body.' },
        { status: 400 }
      )
    }

    const provider = (process.env.AI_PROVIDER || 'huggingface').toLowerCase()
    const apiKey =
      provider === 'gemini'
        ? process.env.GEMINI_API_KEY
        : provider === 'huggingface'
          ? process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN
          : process.env.OPENAI_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: 'AI provider is not configured. Set the appropriate API key in .env.local.' },
        { status: 500 }
      )
    }

    let query = supabase
      .from(LEADS_TABLE)
      .select('data, embedding')
      .not('embedding', 'is', null)
      .order('created_at', { ascending: false })
    if (maxLeads !== undefined && maxLeads > 0) {
      query = query.limit(maxLeads)
    }
    let rows: { data: unknown; embedding: unknown }[] | null = null
    let supabaseError: { message: string } | null = null
    const maxTries = 3
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        const result = await query
        rows = result.data
        supabaseError = result.error
        break
      } catch (fetchErr: unknown) {
        const code = fetchErr && typeof fetchErr === 'object' && 'code' in fetchErr ? (fetchErr as { code: string }).code : ''
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        const isRetryable = code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || /fetch failed/i.test(msg)
        if (isRetryable && attempt < maxTries) {
          await new Promise((r) => setTimeout(r, 800 * attempt))
          continue
        }
        return NextResponse.json(
          {
            error: code === 'ECONNRESET'
              ? 'Connection was reset (timeout or network). Try again or reduce the number of leads (maxLeads).'
              : `Cannot reach Supabase: ${msg}. Check NEXT_PUBLIC_SUPABASE_URL and network.`,
          },
          { status: 503 }
        )
      }
    }

    if (supabaseError) {
      const msg = supabaseError.message
      const tableMissing = getTableMissingMessage(msg)
      if (tableMissing) {
        return NextResponse.json({ error: tableMissing }, { status: 503 })
      }
      const isNetwork = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(msg)
      return NextResponse.json(
        {
          error: isNetwork
            ? `Cannot reach Supabase: ${msg}. Check NEXT_PUBLIC_SUPABASE_URL (https://xxx.supabase.co) and that the server can access the internet.`
            : 'Failed to load leads: ' + msg,
        },
        { status: isNetwork ? 503 : 500 }
      )
    }

    const leads = (rows ?? []).map((r) => r.data as Record<string, string>).filter(Boolean)
    const leadEmbeddings = (rows ?? []).map((r) => r.embedding as number[]).filter((e) => Array.isArray(e) && e.length > 0)
    if (leads.length === 0 || leadEmbeddings.length !== leads.length) {
      return NextResponse.json(
        {
          error:
            leadEmbeddings.length !== leads.length
              ? 'No leads with stored embeddings. Re-ingest the CSV via POST /api/leads/ingest to compute and store embeddings.'
              : 'No leads in the database. Ingest a CSV first via POST /api/leads/ingest',
        },
        { status: 400 }
      )
    }

    const { targetText, avoidText, preferText } = parseProfileForEmbedding(characteristics)
    const embeddingCalls = 1 + (avoidText ? 1 : 0) + (preferText ? 1 : 0)

    const result = await rankLeadsAgainstPersona(leads, characteristics, {
      topN: 10,
      maxLeads: undefined,
      leadEmbeddings,
    })

    if (result.rankedLeads.length === 0) {
      return NextResponse.json(
        { error: 'No leads found matching the characteristics' },
        { status: 400 }
      )
    }

    return NextResponse.json({
      rankedLeads: result.rankedLeads,
      totalProcessed: result.totalProcessed,
      totalMatched: result.totalMatched,
      stats: { embeddingCalls },
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Supabase is not configured')) {
      return NextResponse.json({ error: err.message }, { status: 503 })
    }
    if (err instanceof Error && err.message.includes('Please provide')) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : ''
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT') {
      return NextResponse.json(
        { error: 'Connection reset or timeout. Try again or use fewer leads (maxLeads).' },
        { status: 503 }
      )
    }
    console.error('Rank DB error:', err)
    return NextResponse.json(
      { error: 'Internal server error: ' + (err instanceof Error ? err.message : 'Unknown') },
      { status: 500 }
    )
  }
}
