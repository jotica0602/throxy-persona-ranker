'use client'

import { useState, useMemo, Fragment } from 'react'
import { rankedLeadsToCsv, rankedLeadsToCsvTopNPerCompany } from '@/lib/csv'

interface RankedLead {
  lead: Record<string, string>
  score: number
  rank: number
  explanation?: string
  similarity?: number
}

interface LeadRankingProps {
  results: RankedLead[]
  stats?: { embeddingCalls?: number }
}

/**
 * Formats the field name for more readable display.
 */
function formatFieldName(key: string): string {
  const fieldMap: Record<string, string> = {
    'lead_first_name': 'First Name',
    'lead_last_name': 'Last Name',
    'lead_job_title': 'Job Title',
    'account_name': 'Company',
    'account_domain': 'Domain',
    'account_employee_range': 'Employee Range',
    'account_industry': 'Industry',
    'Full Name': 'Full Name',
    'Title': 'Job Title',
    'Company': 'Company',
    'LI': 'LinkedIn',
    'Employee Range': 'Employee Range',
    'Rank': 'Original Rank',
  }

  if (fieldMap[key]) {
    return fieldMap[key]
  }

  // Format names from snake_case or camelCase
  return key
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Gets the value of a field using different possible field names.
 */
function getFieldValue(lead: Record<string, string>, possibleFields: string[]): string {
  for (const field of possibleFields) {
    const value = lead[field] || lead[field.toLowerCase()] || lead[field.toUpperCase()]
    if (value && value.trim()) {
      return value
    }
  }
  return ''
}

/**
 * Gets the important fields in priority order.
 */
function getImportantFields(lead: Record<string, string>): Array<{ key: string; value: string; label: string }> {
  const fields: Array<{ key: string; value: string; label: string }> = []

  // Full Name
  const fullName = getFieldValue(lead, ['Full Name', 'full_name'])
  const firstName = getFieldValue(lead, ['lead_first_name'])
  const lastName = getFieldValue(lead, ['lead_last_name'])
  if (fullName) {
    fields.push({ key: 'Full Name', value: fullName, label: 'Full Name' })
  } else if (firstName || lastName) {
    fields.push({ 
      key: 'name', 
      value: `${firstName} ${lastName}`.trim(), 
      label: 'Full Name' 
    })
  }

  // Job Title
  const title = getFieldValue(lead, ['lead_job_title', 'Title', 'title'])
  if (title) {
    fields.push({ key: 'title', value: title, label: 'Job Title' })
  }

  // Company
  const company = getFieldValue(lead, ['account_name', 'Company', 'company'])
  if (company) {
    fields.push({ key: 'company', value: company, label: 'Company' })
  }

  // Industry
  const industry = getFieldValue(lead, ['account_industry', 'Industry', 'industry'])
  if (industry) {
    fields.push({ key: 'industry', value: industry, label: 'Industry' })
  }

  // Employee Range
  const employeeRange = getFieldValue(lead, ['account_employee_range', 'Employee Range', 'employee_range'])
  if (employeeRange) {
    fields.push({ key: 'employee_range', value: employeeRange, label: 'Employee Range' })
  }

  // Domain
  const domain = getFieldValue(lead, ['account_domain', 'domain'])
  if (domain) {
    fields.push({ key: 'domain', value: domain, label: 'Domain' })
  }

  // LinkedIn
  const linkedin = getFieldValue(lead, ['LI', 'linkedin', 'LinkedIn'])
  if (linkedin) {
    fields.push({ key: 'linkedin', value: linkedin, label: 'LinkedIn' })
  }

  // Add any other fields not already shown
  const shownKeys = new Set(fields.map(f => f.key.toLowerCase()))
  Object.entries(lead).forEach(([key, value]) => {
    if (value && value.trim() && !shownKeys.has(key.toLowerCase())) {
      fields.push({ key, value, label: formatFieldName(key) })
    }
  })

  return fields
}

/** Name + title for the main line (e.g. "Jane Doe · VP Sales") */
function getLeadNameTitle(lead: Record<string, string>): string {
  const name = getFieldValue(lead, ['Full Name', 'full_name']) ||
    `${getFieldValue(lead, ['lead_first_name'])} ${getFieldValue(lead, ['lead_last_name'])}`.trim()
  const title = getFieldValue(lead, ['lead_job_title', 'Title', 'title'])
  if (name && title) return `${name} · ${title}`
  if (name) return name
  if (title) return title
  return 'Lead'
}

/** Company (and optional extra) for the subline */
function getLeadSubline(lead: Record<string, string>): string {
  return getFieldValue(lead, ['account_name', 'Company', 'company']) ||
    getFieldValue(lead, ['account_industry', 'Industry', 'industry']) ||
    ''
}

function getLeadName(lead: Record<string, string>): string {
  const fullName = getFieldValue(lead, ['Full Name', 'full_name'])
  if (fullName) return fullName
  const first = getFieldValue(lead, ['lead_first_name'])
  const last = getFieldValue(lead, ['lead_last_name'])
  return `${first} ${last}`.trim() || '—'
}

function getLeadLinkedIn(lead: Record<string, string>): string {
  return getFieldValue(lead, ['LI', 'linkedin', 'LinkedIn']) || ''
}

const TOP_N_OPTIONS = [3, 5, 10] as const

type SortKey = 'rank' | 'name' | 'title' | 'company' | 'score'
type SortDir = 'asc' | 'desc'

export default function LeadRanking({ results, stats }: LeadRankingProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [topNPerCompany, setTopNPerCompany] = useState<number>(3)
  const [sortKey, setSortKey] = useState<SortKey>('rank')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const sortedResults = useMemo(() => {
    const arr = [...results]
    arr.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'rank':
          cmp = a.rank - b.rank
          break
        case 'name':
          cmp = getLeadName(a.lead).localeCompare(getLeadName(b.lead))
          break
        case 'title':
          cmp = (getFieldValue(a.lead, ['lead_job_title', 'Title', 'title']) || '').localeCompare(getFieldValue(b.lead, ['lead_job_title', 'Title', 'title']) || '')
          break
        case 'company':
          cmp = (getFieldValue(a.lead, ['account_name', 'Company', 'company']) || '').localeCompare(getFieldValue(b.lead, ['account_name', 'Company', 'company']) || '')
          break
        case 'score':
          cmp = a.score - b.score
          break
        default:
          cmp = a.rank - b.rank
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [results, sortKey, sortDir])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(key === 'rank' ? 'asc' : 'asc')
    }
  }

  const toggle = (index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const handleRowClick = (index: number) => (e: React.MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as HTMLElement).closest('a')) return
    toggle(index)
  }

  const handleRowKeyDown = (index: number) => (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle(index)
    }
  }

  const handleExportCsv = () => {
    const csv = rankedLeadsToCsv(results)
    downloadCsv(csv, `lros-ranking-${new Date().toISOString().slice(0, 10)}.csv`)
  }

  const handleExportTopNPerCompany = () => {
    const csv = rankedLeadsToCsvTopNPerCompany(results, topNPerCompany)
    downloadCsv(csv, `lros-top-${topNPerCompany}-per-company-${new Date().toISOString().slice(0, 10)}.csv`)
  }

  function downloadCsv(csv: string, filename: string) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!results || results.length === 0) {
    return <div className="error">No results found</div>
  }

  return (
    <section className="ranking-section">
      <div className="ranking-header">
        <h2 className="ranking-title">Top leads by fit</h2>
        <div className="ranking-header-actions">
          {stats?.embeddingCalls != null && (
            <span className="ranking-stats" title="Embedding API calls in last run">
              {stats.embeddingCalls} API call{stats.embeddingCalls !== 1 ? 's' : ''}
            </span>
          )}
          <span className="ranking-meta">{results.length} lead{results.length !== 1 ? 's' : ''} ranked</span>
          <div className="ranking-top-per-company">
            <label htmlFor="ranking-top-n-select" className="ranking-top-per-company-label">
              Top per company
            </label>
            <select
              id="ranking-top-n-select"
              className="ranking-top-per-company-select"
              value={topNPerCompany}
              onChange={(e) => setTopNPerCompany(Number(e.target.value))}
              aria-label="Max leads per company when exporting"
            >
              {TOP_N_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <button type="button" className="button-secondary" onClick={handleExportCsv}>
            Export full list
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={handleExportTopNPerCompany}
            title={`Export up to ${topNPerCompany} lead${topNPerCompany !== 1 ? 's' : ''} per company`}
          >
            Export top per company
          </button>
        </div>
      </div>

      <div className="ranking-table-wrap">
        <table className="ranking-table">
          <thead>
            <tr>
              <th className="ranking-th-sortable" onClick={() => handleSort('rank')}>
                Rank {sortKey === 'rank' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th className="ranking-th-sortable" onClick={() => handleSort('name')}>
                Name {sortKey === 'name' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th className="ranking-th-sortable" onClick={() => handleSort('title')}>
                Job Title {sortKey === 'title' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th className="ranking-th-sortable" onClick={() => handleSort('company')}>
                Company {sortKey === 'company' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
              <th className="ranking-th-sortable" onClick={() => handleSort('score')}>
                Score {sortKey === 'score' && (sortDir === 'asc' ? '↑' : '↓')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedResults.map((item, idx) => {
              const importantFields = getImportantFields(item.lead)
              const isExpanded = expanded.has(idx)
              return (
                <Fragment key={`${item.rank}-${idx}-${getLeadName(item.lead)}`}>
                  <tr
                    role="button"
                    tabIndex={0}
                    onClick={handleRowClick(idx)}
                    onKeyDown={handleRowKeyDown(idx)}
                    className={`ranking-table-row-clickable ${isExpanded ? 'ranking-table-row-expanded' : ''}`}
                    title={isExpanded ? 'Hide card' : 'View candidate card'}
                  >
                    <td className="ranking-table-rank">{item.rank}</td>
                    <td>{getLeadName(item.lead)}</td>
                    <td>{getFieldValue(item.lead, ['lead_job_title', 'Title', 'title']) || '—'}</td>
                    <td>{getFieldValue(item.lead, ['account_name', 'Company', 'company']) || '—'}</td>
                    <td className="ranking-table-score">{(item.score * 100).toFixed(1)}%</td>
                  </tr>
                  <tr className="ranking-table-detail-row">
                    <td colSpan={5} className="ranking-table-detail-cell">
                      <div
                        className={`ranking-table-detail-inner ${isExpanded ? 'is-expanded' : ''}`}
                        aria-hidden={!isExpanded}
                      >
                        <div className="ranking-card-body ranking-card-body--inline">
                          <div className="ranking-card-body-inner">
                            {item.explanation && (
                              <div className="ranking-explanation">
                                <strong className="ranking-explanation-title">Why this match</strong>
                                <p className="ranking-explanation-text">{item.explanation}</p>
                              </div>
                            )}
                            <div className="ranking-fields">
                              {importantFields.map((field) => (
                                <div key={field.key} className="ranking-field">
                                  <span className="ranking-field-label">{field.label}</span>
                                  <span className="ranking-field-value">
                                    {field.key === 'linkedin' && field.value && (field.value.startsWith('http') || field.value.includes('linkedin.com'))
                                      ? <a href={field.value.startsWith('http') ? field.value : `https://${field.value}`} target="_blank" rel="noopener noreferrer">{field.value}</a>
                                      : (field.value || '—')}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
