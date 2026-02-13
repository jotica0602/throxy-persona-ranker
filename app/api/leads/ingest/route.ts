import { NextRequest, NextResponse } from 'next/server'
import Papa from 'papaparse'
import { getSupabase, LEADS_TABLE } from '@/lib/supabase'
import { ensureLeadsTable, getTableMissingMessage } from '@/lib/db-migrate'
import { leadToText, generateEmbeddingBatch } from '@/lib/embeddings'

const INGEST_EMBED_BATCH_SIZE = 32
/** Max rows per request to avoid serverless timeouts (~60s on Vercel). Ingest in chunks if you have more. */
const INGEST_MAX_ROWS = 400

/**
 * Ingest leads from CSV into the database and compute+store embeddings.
 * POST body: multipart/form-data with "csv" file.
 * Query: ?clear=1 to delete existing leads before inserting.
 * Creates the leads table automatically if DATABASE_URL is set.
 */
export async function POST(request: NextRequest) {
  try {
    await ensureLeadsTable()
    const supabase = getSupabase()
    const formData = await request.formData()
    const csvFile = formData.get('csv') as File | null
    const clear = request.nextUrl.searchParams.get('clear') === '1'

    if (!csvFile) {
      return NextResponse.json({ error: 'CSV file not provided. Send as form field "csv".' }, { status: 400 })
    }

    const csvText = await csvFile.text()
    const parseResult = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
    })

    if (parseResult.errors.length > 0) {
      return NextResponse.json(
        { error: 'Error parsing CSV: ' + parseResult.errors[0].message },
        { status: 400 }
      )
    }

    const rows = parseResult.data as Record<string, string>[]
    if (rows.length === 0) {
      return NextResponse.json({ error: 'CSV contains no data rows' }, { status: 400 })
    }
    if (rows.length > INGEST_MAX_ROWS) {
      return NextResponse.json(
        {
          error: `Too many rows (${rows.length}). Max ${INGEST_MAX_ROWS} per request to avoid timeouts. Split your CSV or send in multiple requests.`,
        },
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
        { error: 'AI provider is required for ingest (embeddings). Set the appropriate API key in .env.local.' },
        { status: 500 }
      )
    }

    if (clear) {
      let delError: { message: string } | null = null
      try {
        const result = await supabase.from(LEADS_TABLE).delete().neq('id', '00000000-0000-0000-0000-000000000000')
        delError = result.error
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const tableMissing = getTableMissingMessage(msg)
        return NextResponse.json(
          { error: tableMissing ?? `Cannot reach Supabase: ${msg}. Check NEXT_PUBLIC_SUPABASE_URL and that the server can access the internet.` },
          { status: 503 }
        )
      }
      if (delError) {
        const msg = delError.message
        const tableMissing = getTableMissingMessage(msg)
        if (tableMissing) {
          return NextResponse.json({ error: tableMissing }, { status: 503 })
        }
        const isNetwork = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(msg)
        return NextResponse.json(
          {
            error: isNetwork
              ? `Cannot reach Supabase: ${msg}. Check NEXT_PUBLIC_SUPABASE_URL (https://xxx.supabase.co) and that the server can access the internet.`
              : 'Failed to clear leads: ' + msg,
          },
          { status: isNetwork ? 503 : 500 }
        )
      }
    }

    const allEmbeddings: number[][] = []
    for (let i = 0; i < rows.length; i += INGEST_EMBED_BATCH_SIZE) {
      const batch = rows.slice(i, i + INGEST_EMBED_BATCH_SIZE)
      const texts = batch.map((row) => leadToText(row))
      const embeddings = await generateEmbeddingBatch(texts)
      allEmbeddings.push(...embeddings)
    }

    const inserts = rows.map((row, i) => ({
      data: row,
      embedding: allEmbeddings[i] ?? null,
    }))

    let data: { id: string }[] | null = null
    let insertError: { message: string } | null = null
    try {
      const result = await supabase.from(LEADS_TABLE).insert(inserts).select('id')
      data = result.data
      insertError = result.error
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const tableMissing = getTableMissingMessage(msg)
      return NextResponse.json(
        { error: tableMissing ?? `Cannot reach Supabase: ${msg}. Check NEXT_PUBLIC_SUPABASE_URL and that the server can access the internet.` },
        { status: 503 }
      )
    }
    if (insertError) {
      const msg = insertError.message
      const tableMissing = getTableMissingMessage(msg)
      if (tableMissing) {
        return NextResponse.json({ error: tableMissing }, { status: 503 })
      }
      const isNetwork = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(msg)
      return NextResponse.json(
        {
          error: isNetwork
            ? `Cannot reach Supabase: ${msg}. Check NEXT_PUBLIC_SUPABASE_URL (https://xxx.supabase.co) and that the server can access the internet.`
            : 'Failed to insert leads: ' + msg,
        },
        { status: isNetwork ? 503 : 500 }
      )
    }

    return NextResponse.json({
      ingested: data?.length ?? rows.length,
      totalRows: rows.length,
      message: clear ? 'Cleared and ingested leads with embeddings.' : 'Ingested leads with embeddings.',
      stats: { embeddingCalls: rows.length },
    })
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Supabase is not configured')) {
      return NextResponse.json({ error: err.message }, { status: 503 })
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (/timeout expired|ETIMEDOUT|ECONNRESET/i.test(msg)) {
      return NextResponse.json(
        {
          error:
            'Database connection timed out. Check DATABASE_URL and network. On serverless (e.g. Vercel) requests are limited to ~60s — try fewer rows per request.',
        },
        { status: 503 }
      )
    }
    console.error('Ingest error:', err)
    return NextResponse.json(
      { error: 'Internal server error: ' + msg },
      { status: 500 }
    )
  }
}
