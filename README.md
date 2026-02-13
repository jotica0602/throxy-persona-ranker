# Lead Ranking for Outbound Sales (LROS)

Aplicación web desarrollada con Next.js y TypeScript para analizar leads desde un archivo CSV y generar un ranking basado en características especificadas.

## Objetivo

El objetivo de la webapp es **cumplir con los requisitos del perfil de lead ideal** definido en la spec del producto. En concreto:

- **Rankear leads** de un CSV según su afinidad con un perfil objetivo (empresa + roles deseados, a evitar y preferidos).
- **Alinear con una persona ideal** como la de [goal/persona_spec.md](goal/persona_spec.md) (Throxy): empresas B2B que venden a verticales complejos, con targets por tamaño de empresa (startup → Founder/CEO; SMB/Mid/Enterprise → VP Sales, Head of SDR, CRO, RevOps, etc.) y exclusiones claras (CEO en mid-market/enterprise, CFO, CTO, HR, etc.).
- **Exportar el ranking** en CSV para usarlo en campañas de outbound.

El texto del perfil (Target / Avoid / Prefer) es el lugar donde se vuelca esa spec en lenguaje natural; la app ofrece un **perfil de ejemplo** basado en la persona Throxy para cargar y adaptar.

## Características

- 📤 Carga de archivos CSV con leads (soporta múltiples formatos)
- 📝 Especificación de características del lead deseado en texto plano
- 🤖 Pipeline con embeddings (sin LLM para respuestas rápidas):
  - **Embeddings**: Convierte características y leads a vectores semánticos
  - **Similarity**: Calcula similitud coseno entre embeddings
  - **Ranking**: Ordena leads por relevancia semántica
- 📊 Ranking visual de leads ordenados por relevancia (score 0-100%)
- 🎨 Interfaz moderna y responsive
- 🔍 Cartas desplegables con los campos de cada lead

## Cómo ejecutar en local

1. **Dependencias**
   ```bash
   npm install
   ```

2. **Variables de entorno** (crea `.env.local`; elige **una** opción de embeddings):

   **Opción A – OpenAI** (por defecto):
   ```bash
   echo "OPENAI_API_KEY=sk-tu-api-key-aqui" > .env.local
   ```
   API key: https://platform.openai.com/api-keys

   **Opción B – Google Gemini** (tier gratuito: 1000 peticiones de embedding/día):
   ```bash
   echo "AI_PROVIDER=gemini" >> .env.local
   echo "GEMINI_API_KEY=tu-gemini-key" >> .env.local
   ```
   API key: https://aistudio.google.com/apikey

   **Opción C – Hugging Face** (tier gratuito, cuota generosa; recomendado si te quedas sin cuota con Gemini):
   ```bash
   echo "AI_PROVIDER=huggingface" >> .env.local
   echo "HUGGINGFACE_TOKEN=tu-token-hf" >> .env.local
   ```
   Token: https://huggingface.co/settings/tokens (crear token con permiso "Inference API").

   **Opcional** – Limitar leads por ejecución (para no gastar toda la cuota diaria de Gemini en una sola corrida):
   ```bash
   echo "MAX_LEADS=400" >> .env.local
   ```

3. **Base de datos (opcional)**  
   Para usar "Rank from database" necesitas Supabase:
   - Crea un proyecto en [Supabase](https://supabase.com).
   - Añade a `.env.local`:
     ```bash
     NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
     SUPABASE_SERVICE_ROLE_KEY=tu-service-role-key
     ```
   - **Crear la tabla `leads`:** opción A) Añade la URL de Postgres y la app la creará sola:
     ```bash
     DATABASE_URL=postgresql://postgres:TU_PASSWORD_DB@db.xxx.supabase.co:5432/postgres
     ```
     (Cópiala desde Supabase → Project Settings → Database → Connection string → URI, modo sesión.) Opción B) Sin `DATABASE_URL`, ejecuta manualmente el SQL de `supabase/migrations/001_leads.sql` y `002_lead_embeddings.sql` en el SQL Editor.
   - En la ingesta se **calculan y persisten los embeddings** de cada lead. Desde la UI puedes "Load CSV into database" o por API:
     ```bash
     curl -X POST http://localhost:3000/api/leads/ingest -F "csv=@data/dataset/leads.csv"
     ```
     Para reemplazar todos los leads: `?clear=1`. Al rankear desde DB se reutilizan esos embeddings (solo se calculan los del perfil persona), ahorrando cómputo.

4. **Arrancar**
   ```bash
   npm run dev
   ```
   Abre [http://localhost:3000](http://localhost:3000).

## Arquitectura (resumen)

- **Frontend:** Next.js 14, formulario con origen de leads (CSV o base de datos), textarea de persona (Target / Avoid / Prefer), ejecución del ranking desde la UI.
- **APIs:**  
  - `POST /api/rank`: ranking a partir del CSV enviado en el body (multipart).  
  - `POST /api/rank/db`: ranking a partir de los leads almacenados en Postgres (body JSON con `characteristics`).  
  - `POST /api/leads/ingest`: ingesta de CSV a la base de datos (sin UI en el MVP).
- **Ranking reutilizable:** la lógica de embeddings + scoring vive en `lib/ranking.ts` y es usada por ambas rutas de ranking (CSV y DB).
- **Persistencia:** Supabase (Postgres); tabla `leads` con `id`, `data` (JSONB), `embedding` (JSONB, opcional), `created_at`. En la ingesta se calculan y guardan los embeddings de cada lead; al rankear desde DB solo se calculan los embeddings del perfil (Target/Avoid/Prefer) y se reutilizan los de los leads.

## Decisiones principales

- **Embeddings sin LLM de generación:** solo embeddings + similitud coseno para velocidad y coste; el ranking es determinista y rápido.
- **Target / Avoid / Prefer:** el perfil se escribe en texto; se parsean las secciones y se generan embeddings separados para penalizar (Avoid) y premiar (Prefer) y así mejorar la precisión.
- **Dos fuentes de leads:** CSV en el request (one-off; embeddings se calculan en cada petición) y base de datos (embeddings calculados y guardados en la ingesta; el ranking solo calcula los del perfil).
- **Resultados en tabla y en cartas:** la tabla cumple el requisito de "display results in a table"; la vista en cartas se mantiene como alternativa.

## Tradeoffs / limitaciones

- **Sin frontend de ingesta:** la spec pide "no frontend needed for ingestion"; la ingesta es por API o script. Un futuro paso sería un formulario "Upload CSV to database".
- **Supabase opcional:** si no configuras Supabase, solo está disponible "Rank from CSV"; la app sigue funcionando.
- **Límite top 10 y score ≥ 0.3:** para mantener el MVP simple; ambos son configurables en código (`lib/ranking.ts`).

## Uso

1. **Origen de leads:** elige **CSV file** (sube un archivo) o **Database** (usa leads ya ingeridos vía `POST /api/leads/ingest`).
2. **Perfil (persona):** en el textarea describe Target / Avoid / Prefer. Usa **"Load example profile"** para cargar el perfil Throxy ([goal/persona_spec.md](goal/persona_spec.md)) y edítalo si quieres.
3. **Genera el ranking:** los resultados se muestran en **tabla** (por defecto) o en **cartas**; puedes **exportar CSV** desde la sección de resultados.

## Formato del CSV

El CSV debe tener una primera fila con encabezados (columnas) y luego filas con los datos de cada lead. La aplicación soporta múltiples formatos de CSV.

### Formato 1: Dataset de Leads
```csv
account_name,lead_first_name,lead_last_name,lead_job_title,account_domain,account_employee_range,account_industry
Steelcase,Juan,Pérez,Director de Ventas,steelcase.com,10001+,Software Development
Allie - AI for Manufacturing,María,García,Head of Sales,allie-ai.com,11-50,Software Development
```

### Formato 2: Evaluación
```csv
Full Name,Title,Company,LI,Employee Range,Rank
Andrew Bass,Founder,Poka Labs,https://linkedin.com/in/andrewbass/,2-10,2
Devansh Gupta,Angel Investor,Poka Labs,https://linkedin.com/in/devansh-gupta/,2-10,-
```

### Pipeline de Matching

El sistema utiliza un pipeline basado solo en embeddings (sin llamadas a LLM de texto):

1. **Persona → Embedding**: Las características del lead deseado se convierten en un vector (OpenAI o Gemini)
2. **Leads → Embeddings**: Cada lead se convierte en texto y luego en embedding (por lotes)
3. **Similarity → Ranking**: Similitud coseno entre el embedding de las características y cada lead
4. **Output**: Top 10 leads ordenados por score

Este enfoque permite un matching semántico más preciso que el simple matching de palabras clave.

### Si te quedas sin cuota (Gemini 1000/día)

- **Usar Hugging Face**: en `.env.local` pon `AI_PROVIDER=huggingface` y `HUGGINGFACE_TOKEN=tu-token` (token en [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)). No tiene el mismo límite diario estricto.
- **Limitar leads por ejecución**: `MAX_LEADS=400` para procesar solo los primeros 400 y repartir la cuota en varias ejecuciones.

### Archivos de Ejemplo

Puedes usar los archivos de ejemplo en la carpeta `data/`:
- `data/dataset/leads.csv` - Dataset principal de leads
- `data/eval/eval_set.csv` - Set de evaluación

## Tecnologías

- Next.js 14
- TypeScript
- React 18
- **Embeddings**: OpenAI, Google Gemini o **Hugging Face** (elegir con `AI_PROVIDER`: `openai`, `gemini` o `huggingface`)
- PapaParse (parsing de CSV)
- CSS Modules

## Estructura del proyecto

```
LROS/
├── app/
│   ├── api/
│   │   ├── leads/
│   │   │   └── ingest/route.ts   # Ingesta CSV a la base de datos
│   │   └── rank/
│   │       ├── route.ts          # Ranking desde CSV (multipart)
│   │       └── db/route.ts       # Ranking desde DB (JSON body)
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── LeadRanking.tsx   # Tabla + cartas y export CSV
│   └── ThemeToggle.tsx
├── lib/
│   ├── embeddings.ts     # Embeddings (OpenAI / Gemini / HF) y leadToText
│   ├── ranking.ts        # Lógica reutilizable de ranking (persona vs leads)
│   ├── supabase.ts       # Cliente Supabase (servidor)
│   ├── csv.ts            # Export CSV
│   └── exampleProfile.ts # Perfil de ejemplo Throxy
├── supabase/
│   └── migrations/
│       ├── 001_leads.sql        # Tabla leads
│       └── 002_lead_embeddings.sql  # Columna embedding (persistida en ingesta)
└── goal/
    ├── persona_spec.md   # Perfil ideal Throxy
    └── task.md           # Requisitos del challenge
```
