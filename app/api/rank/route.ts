import { NextRequest, NextResponse } from 'next/server'
import Papa from 'papaparse'
import { rankLeadsAgainstPersona } from '@/lib/ranking'

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const csvFile = formData.get('csv') as File
    const characteristics = formData.get('characteristics') as string

    if (!csvFile) {
      return NextResponse.json(
        { error: 'CSV file not provided' },
        { status: 400 }
      )
    }

    if (!characteristics) {
      return NextResponse.json(
        { error: 'Characteristics not provided' },
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
      const msg =
        provider === 'gemini'
          ? 'GEMINI_API_KEY is not configured. Set AI_PROVIDER=gemini and add GEMINI_API_KEY to .env.local.'
          : provider === 'huggingface'
            ? 'HUGGINGFACE_TOKEN (or HF_TOKEN) is not configured. Get a token at https://huggingface.co/settings/tokens'
            : 'Set OPENAI_API_KEY, or use AI_PROVIDER=gemini / AI_PROVIDER=huggingface with the matching API key.'
      return NextResponse.json({ error: msg }, { status: 500 })
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

    let leads = parseResult.data as Record<string, string>[]
    if (leads.length === 0) {
      return NextResponse.json(
        { error: 'CSV file contains no leads' },
        { status: 400 }
      )
    }

    const result = await rankLeadsAgainstPersona(leads, characteristics)

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
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Please provide')) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    console.error('Error processing leads:', error)
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    )
  }
}
