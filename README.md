# Throxy Persona Ranker (LROS)

A web app to **rank leads** by how well they match an ideal profile. You describe who you want to reach (and who to avoid or prefer), then the app scores leads using semantic embeddings and shows a sortable table. Export the full ranking or top N per company to CSV for outbound campaigns.

## What it’s for

- **Rank leads** from a CSV or from a database by affinity to a text profile (target roles/companies, avoid, prefer).
- **Semantic matching** via embeddings (no generative LLM): your profile and each lead are turned into vectors; cosine similarity gives a 0–100% score.
- **Optimize the profile** (optional): use an evaluation set and an LLM (Gemini, Groq, or Anthropic) to refine your Target / Avoid / Prefer text so the ranking aligns better with a gold order.

The ideal profile is described in natural language using **Target** (who you want), **Avoid** (who to exclude), and **Prefer** (what to prioritize). You can write free-form or use the example Throxy profile and adapt it.

## How to use it

1. **Get leads in**
   - **Upload a CSV** in step 1; the file is stored and its leads are used for this run, or  
   - Use **leads already in the database** (ingested via API or a previous upload).

2. **Describe your ideal profile** (step 2)  
   In the text area, describe who you want to reach. You can use **Target:** / **Avoid:** / **Prefer:** or write freely; use **Load example profile** to start from the Throxy spec and edit.

3. **Run the ranking**  
   Click **Rank leads**. Results appear in a table; click a row to expand the lead card. Use **Export full list** or **Export top per company** (choose 3, 5, or 10 per company) to download CSV.

4. **Optional: optimize the profile** (step 3)  
   If you have an evaluation set and an API key (Gemini, Groq, or Anthropic), use **Run prompt optimization** to get a refined profile and see the new score.

## Run locally

1. **Install and env**
   ```bash
   npm install
   cp .env.example .env.local
   ```
   Edit `.env.local`: set at least one embedding provider.
   - **Hugging Face** (recommended, generous free tier): `AI_PROVIDER=huggingface`, `HUGGINGFACE_TOKEN=…`
   - **Gemini** (free tier: 1000 embeddings/day): `AI_PROVIDER=gemini`, `GEMINI_API_KEY=…`
   - **OpenAI**: `OPENAI_API_KEY=…` (default provider if not set)

2. **Optional – database (for “Rank from database”)**
   - Create a [Supabase](https://supabase.com) project.
   - In `.env.local`: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
   - To auto-create the `leads` table: set `DATABASE_URL` (Postgres connection string from Supabase). Otherwise run the SQL in `supabase/migrations/` in the SQL Editor.
   - For **prompt optimization**, run `supabase/migrations/003_eval_lead_embeddings.sql` so eval set embeddings are cached and not re-computed on every run.
   - Ingest CSV via API: `POST /api/leads/ingest` with `csv` file (use `?clear=1` to replace existing leads).

3. **Start**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

See `.env.example` for all supported variables (e.g. `MAX_LEADS`, prompt-optimizer keys).

## CSV format

The app accepts CSVs with a header row and flexible column names. Examples:

- **Leads:** `account_name`, `lead_first_name`, `lead_last_name`, `lead_job_title`, `account_domain`, `account_employee_range`, `account_industry`
- **Eval set:** `Full Name`, `Title`, `Company`, `LI`, `Employee Range`, `Rank`

Multiple naming conventions (e.g. `Title` vs `lead_job_title`) are supported.

## Tech and structure

- **Stack:** Next.js 14, TypeScript, React 18. Embeddings: OpenAI, Gemini, or Hugging Face (via `AI_PROVIDER`). Optional: Supabase (Postgres) for storing leads and embeddings.
- **APIs:** `POST /api/rank` (rank from CSV in body), `POST /api/rank/db` (rank from DB; body: `{ characteristics }`), `POST /api/leads/ingest` (ingest CSV into DB), `POST /api/prompt-optimize` (optimize profile with an LLM).
- **Core logic:** `lib/ranking.ts` (embedding + scoring), `lib/embeddings.ts` (embedding providers, profile parsing), `lib/csv.ts` (export, top-N-per-company). UI: `app/page.tsx`, `components/LeadRanking.tsx`.
