# VT Seminar Aggregator — Build Spec

## What this is
A personal tool that pulls research seminars from across Virginia Tech departments into one
filterable place, with AI-precomputed prerequisite/context annotations per talk. It is a
**static site fed by a scheduled batch job**. No backend, no database, near-zero running cost.

Target scale: a few hundred talks per semester across ~5 departments. This smallness is
load-bearing — it's *why* there's no database and no server. Do not design for more.

---

## Hard architectural constraints (decided — do not silently deviate)
If you think one of these is wrong, **say so before building**. Don't quietly change it.

1. **No backend server.** No always-on process.
2. **No database.** Data is a single flat JSON file committed to the repo. The dataset is a few MB
   at most, fits in memory, and ships to the browser in one request. Git history gives free
   versioning for free.
3. **No scraping middleman** (no Firecrawl / Scrapfly / etc.). Fetch pages directly over plain HTTP —
   targets are public `.edu` pages with no anti-bot.
4. **No live per-user endpoints, no serverless functions (in v1).** Every feature must be
   precomputable at build time. Annotations are identical for every viewer, so they're computed
   once during ingest and baked into the JSON.
5. **All filtering/search happens client-side** in the browser, over the shipped JSON.
6. Ingest runs as a **scheduled GitHub Action** (weekly cron), never on the user's machine.
7. Output is served via **GitHub Pages**.
8. **Plain JavaScript, no TypeScript.** No transpile step, no tsconfig. Schema safety is handled at
   runtime (see below), which is the only place it actually matters here.

---

## The pipeline (this is basically the whole app)

**Ingest script**, run weekly by the Action:
1. **Fetch** — for each configured source URL, plain HTTP GET the page.
   - First check whether the seminar list is server-rendered HTML (plain `fetch` works) or requires
     JS to appear (then, and only then, use a headless browser like Playwright). Most `.edu`
     department pages are server-rendered — prefer plain fetch and avoid the browser dependency if
     you can.
2. **Reduce** — strip the HTML to clean main-content text *before* the LLM sees it (e.g.
   `@mozilla/readability` + `jsdom`). This cuts tokens and improves extraction accuracy. Do not feed
   raw HTML to the model.
3. **Extract** — one LLM call per page, constrained to the JSON schema below via Gemini's
   structured-output mode (`responseSchema`), returning an array of talk objects. **Validate the
   parsed result at runtime before accepting it** (see stack notes). Must correctly handle pages
   listing **multiple talks** (segment and associate fields per talk — this is the main failure
   mode).
4. **Annotate** — produce the prerequisite/context fields (see schema + extraction rules). Fine to
   do in the same call as extraction, or one follow-up call per talk.
5. **Merge + dedupe** — combine all sources into one array, dedupe on (title + date + speaker),
   assign stable ids.
6. **Write** — output `data/seminars.json`, commit it back to the repo.

**Frontend** (static, served by Pages):
- Fetches `data/seminars.json` on load.
- Renders a filterable/searchable list: filter by department/series and date range; free-text search
  over title/speaker/abstract. All in-browser.
- Each talk shows its precomputed prerequisites and context, with a **visible disclaimer** that these
  are AI-generated.

---

## Data schema (per talk)
```json
{
  "id": "string — stable hash of title+date+speaker",
  "title": "string",
  "speaker": "string | null",
  "affiliation": "string | null",
  "department": "string — e.g. 'Mathematics', 'Statistics'",
  "series": "string | null — e.g. 'Geometry/Topology Seminar', 'Colloquium'",
  "datetime_start": "ISO 8601 | null",
  "datetime_end": "ISO 8601 | null",
  "location": "string | null",
  "abstract": "string | null",
  "source_url": "string — the page this was extracted from",
  "annotations": {
    "prerequisites": ["string — concrete topics/courses a listener should know"],
    "related_concepts": ["string"],
    "one_line_context": "string — what this talk is about, in plain terms",
    "ai_generated": true
  }
}
```

---

## Schema validation is a RUNTIME concern (read this — it's the reason there's no TypeScript)
The untrusted boundary in this app is the **LLM's output**: occasionally-malformed or hallucinated
JSON. Compile-time types cannot check any of it, because the types are gone by the time that JSON
actually arrives. So enforce the schema at runtime, in two layers:
1. **Constrain the model.** Use Gemini's structured output (`responseMimeType: "application/json"` +
   `responseSchema` matching the schema above) so it returns schema-valid JSON at the API level.
2. **Check values after parsing.** A light hand-rolled validator: title present, `datetime_start`
   parses as a real date, talks array non-empty, required fields non-empty. (A schema lib like Zod
   is optional sugar for this — not required. No types needed either way.)

On validation failure: retry the call once, then skip that page and log it. **Never write
unvalidated data to `seminars.json`.**

---

## Extraction rules (these encode hard-won lessons — follow them)
- **DO** extract: `prerequisites` (concrete topics/courses), `related_concepts`, and a
  plain-language `one_line_context`. These are supportable from title + abstract.
- **DO NOT** fabricate a "beginner-friendly" / difficulty / accessibility rating. Whether a talk is
  accessible depends on the *speaker's delivery*, which the abstract cannot reveal. Inventing this is
  the single biggest hallucination risk. Prerequisites and topic-mapping are grounded; friendliness
  is not.
- **Do not invent missing data.** If a page has no abstract or a TBA speaker, the field is `null`.
- Every annotation must be flagged `ai_generated: true` and surfaced with a disclaimer in the UI.

---

## Config (churn-proofing)
- **Source URLs** live in a config file (`config/sources.json` or similar) so adding a department is
  a one-line change.
- **LLM model name** lives in a config/env var — NOT hardcoded across the code. Free-tier model names
  change often; expect to swap it.
- **Gemini API key** is a GitHub Actions secret (`GEMINI_API_KEY`), never committed.

Default LLM: **Google Gemini free tier** (Flash / Flash-Lite), called directly via its API. At this
volume (~dozens of calls per week against a ~1,500/day free allowance) cost is $0 and stays $0.

---

## Correctness bar / eval (build this — do not skip it)
- Create a tiny ground-truth set: for **2 source pages**, hand-write the expected extracted output
  (`eval/expected/<source>.json`).
- An `eval` script runs live extraction on those pages and reports **field-level accuracy** vs
  expected.
- **Target: ~95% field accuracy** before v1 is "done."
- The real failure modes to measure are: **multi-talk segmentation**, **date/time parsing**, and
  **missing-field handling** — not model intelligence. Do not go shopping for a smarter model; if the
  cheapest one clears the bar, ship it.

---

## Suggested stack (defaults, not constraints)
- **Ingest:** Node + plain **JavaScript** — no TypeScript, no transpile step. A Readability-style
  extractor (`@mozilla/readability` + `jsdom`) for the reduce step. (`llm-scraper` bundles
  fetch+reduce+extract if you'd rather not wire it by hand — but it pulls in Playwright, so only use
  it if the pages actually need JS rendering.)
- **Schema safety:** runtime only — Gemini `responseSchema` + a light value check (see the
  runtime-validation section). No compile-time types.
- **Frontend:** keep it dead simple — a single static page, vanilla JS. A filtered list over a ~1 MB
  JSON file does not need a framework or a build step. (If you do add a build step, the Action must
  build before deploying to Pages.)
- **Schedule + host:** GitHub Actions (weekly cron) + GitHub Pages.

---

## Suggested structure
```
vt-seminars/
├── config/
│   └── sources.json          # list of { department, series, url }
├── src/
│   ├── fetch.js              # plain HTTP GET
│   ├── reduce.js             # HTML -> clean text
│   ├── extract.js            # clean text -> talks via Gemini responseSchema + runtime validation
│   ├── annotate.js           # prereqs / context fields
│   ├── merge.js              # dedupe + stable ids
│   └── ingest.js             # orchestrates the above, writes data/seminars.json
├── eval/
│   ├── expected/             # hand-labeled ground truth for 2 pages
│   └── run-eval.js
├── data/
│   └── seminars.json         # the "database" — committed by the Action
├── web/                      # static frontend served by Pages
│   └── index.html
├── .github/workflows/
│   └── ingest.yml            # weekly cron: run ingest, commit JSON, deploy Pages
└── README.md
```

---

## Initial sources (start SMALL — get the pipeline working end-to-end first)
- Virginia Tech Math seminar series pages under `seminar.math.vt.edu` (start with 1–2 series relevant
  to a probability/analysis track).
- Virginia Tech Statistics colloquium schedule page under `stat.vt.edu`.

Wire up **2–3 sources**, get the full fetch→reduce→extract→annotate→write→display loop working, pass
the eval, deploy — *then* add more departments. Do not start by trying to cover everything.

---

## Future (explicitly NOT v1 — do not build now)
A live "ask a question about this talk" chat, or a "personalize this explanation to my background"
feature, genuinely can't be precomputed (the input is the individual user). *That* is the one case
that would need a single serverless function (to hide the API key and call the LLM at request time).
The architecture above is designed so such a function slots in cleanly later — one decoupled
endpoint, no rearchitecting. **Do not build it now.** v1 is precompute-and-serve-static, full stop.

---

## NON-GOALS (out of scope — actively do not build these)
- No database of any kind.
- No backend / server / serverless functions (yet).
- No TypeScript / build step for the ingest script.
- No live per-user features.
- No support for any university other than Virginia Tech. No "generic extractor." The entire
  simplicity/cost story depends on staying at VT-cluster scale.
- No "beginner-friendly" / difficulty ratings.

---

## Definition of done (v1)
- `npm run ingest` fetches the configured sources, extracts + annotates, validates at runtime, and
  writes `data/seminars.json`.
- The eval script passes at ~95% field accuracy on the ground-truth pages.
- The static frontend loads the JSON and filters/searches entirely client-side.
- A GitHub Action runs ingest on a weekly cron, commits the updated JSON, and deploys the site to
  Pages.
- README documents how to add a source and how to run the eval.
