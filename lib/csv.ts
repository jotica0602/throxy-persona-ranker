/**
 * Escapes a value for RFC 4180 CSV (wrap in quotes if contains comma, newline, or quote).
 */
function escapeCsvValue(value: string): string {
  const s = String(value ?? '')
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * Builds a CSV string from an array of objects. Uses the keys of the first object as header.
 * Ensures all rows have the same columns (fills missing with empty string).
 */
export function buildCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return ''
  const allKeys = new Set<string>()
  rows.forEach((row) => Object.keys(row).forEach((k) => allKeys.add(k)))
  const headers = Array.from(allKeys)
  const headerLine = headers.map(escapeCsvValue).join(',')
  const dataLines = rows.map((row) =>
    headers.map((h) => escapeCsvValue(String(row[h] ?? ''))).join(',')
  )
  return [headerLine, ...dataLines].join('\r\n')
}

const COMPANY_FIELDS = ['account_name', 'Company', 'company']

function getCompany(lead: Record<string, string>): string {
  for (const field of COMPANY_FIELDS) {
    const v = lead[field] ?? lead[field.toLowerCase()] ?? lead[field.toUpperCase()]
    if (v && String(v).trim()) return String(v).trim()
  }
  return ''
}

/**
 * From ranked results, keeps only the top N leads per company (by global rank).
 * Returns a flat list with CompanyRank (1..N within company) for CSV.
 */
export function topNPerCompany(
  results: { rank: number; score: number; lead: Record<string, string> }[],
  n: number
): { rank: number; score: number; lead: Record<string, string>; companyRank: number }[] {
  const byCompany = new Map<string, { rank: number; score: number; lead: Record<string, string> }[]>()
  for (const r of results) {
    const company = getCompany(r.lead) || '(No company)'
    if (!byCompany.has(company)) byCompany.set(company, [])
    byCompany.get(company)!.push(r)
  }
  const out: { rank: number; score: number; lead: Record<string, string>; companyRank: number }[] = []
  Array.from(byCompany.values()).forEach((leads) => {
    const top = leads.slice(0, n)
    top.forEach((r: { rank: number; score: number; lead: Record<string, string> }, i: number) =>
      out.push({ ...r, companyRank: i + 1 })
    )
  })
  out.sort((a, b) => a.rank - b.rank)
  return out
}

/**
 * Converts ranked leads to CSV rows (Rank, Score %, then all lead fields) and returns the CSV string.
 */
export function rankedLeadsToCsv(
  results: { rank: number; score: number; lead: Record<string, string> }[]
): string {
  const rows = results.map((r) => ({
    Rank: String(r.rank),
    'Score %': (r.score * 100).toFixed(1),
    ...r.lead,
  }))
  return buildCsv(rows)
}

/**
 * Exports top N leads per company to CSV. Adds "Rank in company" column (1..N).
 */
export function rankedLeadsToCsvTopNPerCompany(
  results: { rank: number; score: number; lead: Record<string, string> }[],
  n: number
): string {
  const filtered = topNPerCompany(results, n)
  const rows = filtered.map((r) => ({
    'Rank in company': String(r.companyRank),
    Rank: String(r.rank),
    'Score %': (r.score * 100).toFixed(1),
    ...r.lead,
  }))
  return buildCsv(rows)
}
