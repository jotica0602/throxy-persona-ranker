'use client'

import { useState, useRef, useEffect } from 'react'
import Image from 'next/image'
import LeadRanking from '@/components/LeadRanking'
import ThemeToggle from '@/components/ThemeToggle'
import { THROXY_EXAMPLE_PROFILE } from '@/lib/exampleProfile'
import throxyIcon from './apple-touch-icon.png'

interface RankedLead {
  lead: Record<string, string>
  score: number
  rank: number
}

export default function Home() {
  const [csvFile, setCsvFile] = useState<File | null>(null)
  const [ingestLoading, setIngestLoading] = useState(false)
  const [ingestProgress, setIngestProgress] = useState<number | null>(null)
  const [ingestMessage, setIngestMessage] = useState<string | null>(null)
  const [characteristics, setCharacteristics] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<RankedLead[] | null>(null)
  const [lastStats, setLastStats] = useState<{ embeddingCalls?: number } | null>(null)
  const [progressStep, setProgressStep] = useState(0)
  const [optimizeLoading, setOptimizeLoading] = useState(false)
  const [optimizeError, setOptimizeError] = useState<string | null>(null)
  const [optimizeResult, setOptimizeResult] = useState<{ bestPrompt: string; bestScore: number; iterations: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const rankingSectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (results && results.length > 0 && rankingSectionRef.current) {
      rankingSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [results])

  const ingestCsv = (file: File) => {
    setIngestLoading(true)
    setIngestProgress(0)
    setError(null)
    setIngestMessage(null)
    const formData = new FormData()
    formData.append('csv', file)
    const xhr = new XMLHttpRequest()
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        setIngestProgress(Math.round((e.loaded / e.total) * 90))
      }
    })
    xhr.addEventListener('load', () => {
      setIngestProgress(100)
      try {
        const data = JSON.parse(xhr.responseText || '{}')
        if (xhr.status >= 200 && xhr.status < 300) {
          setIngestMessage(`Saved ${data.ingested ?? data.totalRows} leads. You can run the ranking below.`)
        } else {
          throw new Error(data.error || 'Failed to save CSV')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        if (msg.includes('Supabase') && msg.includes('not configured')) {
          setError('Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local.')
        } else {
          setError(msg)
        }
        setCsvFile(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
      } finally {
        setIngestLoading(false)
        setIngestProgress(null)
      }
    })
    xhr.addEventListener('error', () => {
      setError('Network error. Please try again.')
      setCsvFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      setIngestLoading(false)
      setIngestProgress(null)
    })
    xhr.addEventListener('abort', () => {
      setIngestLoading(false)
      setIngestProgress(null)
    })
    xhr.open('POST', '/api/leads/ingest?clear=1')
    xhr.send(formData)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvFile(file)
    setError(null)
    ingestCsv(file)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!characteristics.trim()) {
      setError('Please describe your company and the candidates you’re looking for')
      return
    }
    setLoading(true)
    setError(null)
    setResults(null)
    setLastStats(null)
    setProgressStep(0)
    const progressInterval = setInterval(() => {
      setProgressStep((s) => Math.min(s + 1, 2))
    }, 1500)
    try {
      const res = await fetch('/api/rank/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characteristics: characteristics.trim() }),
      })
      const data = await res.json()
      clearInterval(progressInterval)
      setProgressStep(2)
      if (!res.ok) throw new Error(data.error || 'Error ranking from database')
      setResults(data.rankedLeads)
      setLastStats(data.stats ?? null)
    } catch (err) {
      clearInterval(progressInterval)
      const msg = err instanceof Error ? err.message : 'Unknown error'
      if (msg.includes('Supabase') && msg.includes('not configured')) {
        setError('Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local (see README).')
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  const runPromptOptimization = async () => {
    setOptimizeLoading(true)
    setOptimizeError(null)
    setOptimizeResult(null)
    try {
      const res = await fetch('/api/prompt-optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initialPrompt: characteristics.trim(),
          maxIterations: 4,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Optimization failed')
      setOptimizeResult({
        bestPrompt: data.bestPrompt,
        bestScore: data.bestScore,
        iterations: data.iterations ?? 0,
      })
    } catch (err) {
      setOptimizeError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setOptimizeLoading(false)
    }
  }

  return (
    <div className="container">
      <div className="page-header">
        <div>
          <h1 className="page-title">
            <Image src={throxyIcon} alt="" width={32} height={32} className="page-title-icon" aria-hidden />
            Throxy Persona Ranker
          </h1>
          <p className="page-subtitle">Rank leads by how well they match an ideal profile</p>
        </div>
        <ThemeToggle />
      </div>

      <p className="flow-intro">
        Upload your CSV, describe who you want to reach, then run the ranking.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="form-steps-grid">
        <section className="form-step">
          <h2 className="form-step-title">
            <span className="form-step-num" aria-hidden>1</span>
            Upload your CSV
          </h2>
          <p className="form-step-desc">Select a file and it will be saved to the database automatically. Then describe your ideal lead and run the ranking.</p>
          <div className="file-input-wrap">
            <input
              ref={fileInputRef}
              id="csv-file"
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              disabled={ingestLoading || loading}
              className="file-input-hidden"
              aria-label="Choose CSV file"
            />
            <label htmlFor="csv-file" className="file-input-button">
              <span className="file-input-icon" aria-hidden>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </span>
              <span className="file-input-text">
                {ingestLoading
                  ? (ingestProgress !== null && ingestProgress < 100 ? `Uploading… ${ingestProgress}%` : 'Saving…')
                  : csvFile
                    ? csvFile.name
                    : 'Choose CSV file'}
              </span>
            </label>
          </div>
          {ingestLoading && (
            <div className="ingest-progress-wrap" role="progressbar" aria-valuenow={ingestProgress ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
              <div className="ingest-progress-bar" style={{ width: `${ingestProgress ?? 0}%` }} />
            </div>
          )}
          {ingestMessage && <p className="success">{ingestMessage}</p>}
        </section>

        <section className="form-step form-step--profile">
          <h2 className="form-step-title">
            <span className="form-step-num" aria-hidden>2</span>
            Who do you want to reach?
          </h2>
          <p className="form-step-desc">Describe your ideal lead. We’ll rank by how well each person matches.</p>
          <div className="form-label-row">
            <label htmlFor="characteristics" className="form-label form-label--inline">Ideal profile</label>
            <button
              type="button"
              className="form-link-button"
              onClick={() => setCharacteristics(THROXY_EXAMPLE_PROFILE)}
              disabled={loading}
            >
              Use example profile
            </button>
          </div>
          <div className="textarea-wrap">
            <textarea
              id="characteristics"
              value={characteristics}
              onChange={(e) => setCharacteristics(e.target.value)}
              placeholder="e.g. We sell outbound tools to B2B. We want VP Sales, Head of SDR; avoid HR and CFO; prefer companies that sell to enterprise."
              disabled={loading}
              aria-describedby="characteristics-hint"
            />
          </div>
          <p id="characteristics-hint" className="form-hint">
            Describe who you want to reach in your own words. You can use Target / Avoid / Prefer or write freely; run &quot;Optimize prompt&quot; to have the model structure and refine it.
          </p>
        </section>

        <section className="form-step form-step--optimize">
          <h2 className="form-step-title">
            <span className="form-step-num" aria-hidden>3</span>
            Optimize prompt (evaluation set)
          </h2>
          <p className="form-step-desc">
            Use 50 pre-ranked leads to automatically improve your persona text. An AI agent will propose prompt changes and we measure agreement with the gold ranking (Spearman). Optional.
          </p>
          {optimizeError && <p className="error-inline">{optimizeError}</p>}
          <div className="form-actions form-actions--inline">
            <button
              type="button"
              className="button button-secondary"
              onClick={runPromptOptimization}
              disabled={optimizeLoading || loading || !characteristics.trim()}
            >
              {optimizeLoading ? 'Optimizing…' : 'Run prompt optimization'}
            </button>
          </div>
          {optimizeResult && (
            <div className="optimize-result">
              <p className="optimize-score">
                Best Spearman correlation: <strong>{optimizeResult.bestScore.toFixed(3)}</strong> (after {optimizeResult.iterations} iterations)
              </p>
              <div className="optimize-prompt-wrap">
                <label className="form-label">Optimized prompt</label>
                <textarea
                  readOnly
                  className="textarea-wrap optimize-prompt-text"
                  value={optimizeResult.bestPrompt}
                  rows={8}
                />
              </div>
              <button
                type="button"
                className="button button--primary"
                onClick={() => {
                  setCharacteristics(optimizeResult!.bestPrompt)
                  setOptimizeResult(null)
                }}
              >
                Use this prompt
              </button>
            </div>
          )}
        </section>
        </div>

        <div className="form-actions">
          <button type="submit" className="button button--primary" disabled={loading}>
            {loading ? 'Ranking…' : 'Rank leads'}
          </button>
        </div>
      </form>

      {error && <div className="error">{error}</div>}

      {loading && (
        <div className="loading loading--steps">
          <div className="loading-steps">
            <div className={`loading-step ${progressStep >= 0 ? 'active' : ''}`}>Embedding profile</div>
            <div className={`loading-step ${progressStep >= 1 ? 'active' : ''}`}>Comparing leads</div>
            <div className={`loading-step ${progressStep >= 2 ? 'active' : ''}`}>Ranking</div>
          </div>
          <div className="loading-note">Using stored lead embeddings</div>
        </div>
      )}

      {results && (
        <div ref={rankingSectionRef}>
          <LeadRanking results={results} stats={lastStats ?? undefined} />
        </div>
      )}
    </div>
  )
}
