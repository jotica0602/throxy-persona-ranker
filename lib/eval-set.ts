import fs from 'fs/promises'
import path from 'path'
import Papa from 'papaparse'

export interface EvalLead {
  lead: Record<string, string>
  goldRank: number
}

const EVAL_CSV_PATH = process.env.EVAL_CSV_PATH || 'data/eval/eval_set.csv'

/** Embedded CSV (generated at build by scripts/embed-eval-csv.js). Evita depender del filesystem en Vercel. */
function getEmbeddedEvalCsv(): string | null {
  try {
    const m = require('./eval-set-csv')
    return m.EVAL_CSV_CONTENT ?? null
  } catch {
    return null
  }
}

/**
 * Parse CSV row into lead object. Expects columns: Full Name, Title, Company, LI, Employee Range, Rank.
 * Only first 6 columns are used for lead data.
 */
function rowToLead(row: Record<string, string>): Record<string, string> {
  const lead: Record<string, string> = {}
  const keys = ['Full Name', 'Title', 'Company', 'LI', 'Employee Range', 'Rank']
  for (const k of keys) {
    const v = row[k] ?? row[k.toLowerCase()] ?? ''
    if (k !== 'Rank' && v != null && String(v).trim()) lead[k] = String(v).trim()
  }
  return lead
}

/**
 * Load and parse the evaluation set CSV. Returns leads that have a numeric Rank (gold ranking).
 * Global gold order: sort by Company, then by Rank, then by Full Name; assign goldRank 1..N.
 */
export async function loadEvalSet(customPath?: string): Promise<EvalLead[]> {
  const useEmbedded = !customPath && !process.env.EVAL_CSV_PATH
  let content: string
  if (useEmbedded) {
    const embedded = getEmbeddedEvalCsv()
    if (embedded) {
      content = embedded
    } else {
      const baseDir = process.cwd()
      const csvPath = path.resolve(baseDir, EVAL_CSV_PATH)
      content = await fs.readFile(csvPath, 'utf-8')
    }
  } else {
    const baseDir = process.cwd()
    const csvPath = path.resolve(baseDir, customPath || EVAL_CSV_PATH)
    content = await fs.readFile(csvPath, 'utf-8')
  }
  const parsed = Papa.parse<Record<string, string>>(content, { header: true, skipEmptyLines: true })
  const rows = (parsed.data || []).filter((r) => r && typeof r === 'object')

  const withRank: { lead: Record<string, string>; company: string; rank: number; fullName: string }[] = []
  for (const row of rows) {
    const rankRaw = (row['Rank'] ?? row['rank'] ?? '').toString().trim()
    if (!rankRaw || rankRaw === '-') continue
    const rankNum = parseInt(rankRaw, 10)
    if (Number.isNaN(rankNum) || rankNum < 1) continue
    const lead = rowToLead(row)
    const company = (lead['Company'] || '').trim() || '(No company)'
    const fullName = (lead['Full Name'] || '').trim() || ''
    withRank.push({ lead, company, rank: rankNum, fullName })
  }

  withRank.sort((a, b) => {
    if (a.company !== b.company) return a.company.localeCompare(b.company)
    if (a.rank !== b.rank) return a.rank - b.rank
    return a.fullName.localeCompare(b.fullName)
  })

  return withRank.map((item, index) => ({
    lead: item.lead,
    goldRank: index + 1,
  }))
}
