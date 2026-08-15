# VT Seminar Aggregator

A personal, **static** site of Virginia Tech research seminars. A weekly batch job extracts talks
from department pages, bakes AI prerequisite/context annotations into one committed JSON file
(`data/seminars.json`), and the frontend filters/searches that JSON entirely client-side. No backend,
no database, near-zero cost.

**Design in one line:** precompute-and-serve-static. A scheduled GitHub Action does all the work
(fetch + LLM extraction) at build time and commits the result; the site is just static files that
read one JSON. Everything below is what you'd touch to run or extend it.

Pipeline: **fetch → reduce → extract → annotate → merge → write**. Plain HTTP GET →
`@mozilla/readability` clean text → Gemini structured extraction (schema-constrained, chunked +
cached) → dedupe/id → `data/seminars.json`. Runs only as a weekly GitHub Action, never on your
machine.

## Develop

```bash
npm ci
npm run dev      # Vite dev server for the frontend (web/)
npm run build    # static build -> dist/
```

## Ingest (normally the Action's job)

```bash
GEMINI_API_KEY=...  npm run ingest    # or put it in a .env file
```

Reads `config/sources.json`, extracts each source, and writes `data/seminars.json` +
`data/extract-cache.json`. The cache keys on the sha256 of each page's reduced text, so unchanged
pages skip the (dominant-cost) Gemini call. The model name comes from `GEMINI_MODEL` or the `"model"`
key in `config/sources.json`.

## Adding a source

Adding a source is a **one-line, data-only change**: append an object to the `"sources"` array in
`config/sources.json`:

```json
{ "department": "Mathematics", "series": "Colloquium", "url": "https://.../seminars.html" }
```

**First, pass the source-selection check:** the page's seminar list must be present in the
**server-rendered HTML**. Verify by running the URL through `reduceHtml` and confirming the
reduced text actually contains the talks (speaker/date/title) — if you get only a masthead + "meeting
info" blurb, the list is JS-injected and the page is **not usable** (plain `fetch` won't see it, and
per project constraints we don't add a headless browser). Note some departments inject their *index*
page but expose a server-rendered archive/schedule URL that works (e.g. Math ANA's `archives.php`).

## Eval (local test suite — not run in CI)

The eval confirms the cheap production model is "good enough" against a strong reference across a
diverse page set. Ground truth lives in `eval/expected/<slug>.json` (authored by a strong reader from
each page's reduced text). The runner fetches each fixture's live page, extracts with the production
model, and diffs field-by-field.

```bash
GEMINI_API_KEY=...  npm run eval
```

- Scores **objective** fields (speaker/affiliation/date/time/location/abstract-presence) strictly;
  model-generated annotations (prerequisites/related_concepts/one_line_context) leniently.
- Reports per-page + aggregate **objective field accuracy** and segmentation errors
  (missing/extra/boilerplate-leak talks). Target **~95%**; exits non-zero below the bar.
- Without `GEMINI_API_KEY` it prints a friendly skip and exits 0.
- Current fixtures exercise distinct failure modes: `math-colloquium` (clean multi-talk),
  `math-algebra` (inline affiliations), `math-geom-top` (No-Seminar rows + synthesized titles +
  concatenated speaker/affiliation), `stat-colloquium` (heavy VT nav chrome + TBA/missing fields).

The eval is intentionally **not in CI** — it costs model calls and its ground truth drifts as pages
change. Run it locally when you touch the extractor, prompt, schema, or reducer.

## CI deploy guard

`.github/workflows/ingest.yml` runs weekly: ingest → **validate** → commit → build → deploy to Pages.
The validate step (`npm run check-data`, `scripts/check-data.js`) is a deterministic gate that runs
**before** commit/deploy and fails the job (so nothing ships) if `data/seminars.json` is empty or
invalid, any talk is missing `id`/`title`/`department`/`source_url`, or the talk count collapsed vs.
the committed copy (< 50% — a mass source failure). No LLM in this path.

```bash
npm run check-data                 # check data/seminars.json
node scripts/check-data.js <path>  # check an arbitrary file
```
