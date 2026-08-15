# CLAUDE.md — VT Seminar Aggregator

This is the working contract for building this project. The full reasoning lives in `spec.md`;
this file is the short, load-bearing version you check your work against on every change. If a
change would violate anything here, **stop and flag it — do not silently deviate.**

**Keep this file current.** Every time a task is considered done, update CLAUDE.md so it still
describes the project as it actually is — new/renamed files, changed module roles, new constraints or
conventions, and any hard-won lesson worth not relearning. Treat updating CLAUDE.md as part of the
definition of done, not an afterthought. Keep it terse; don't let it drift from the real code.

## One-line summary
A personal, static site of Virginia Tech research seminars, aggregated by a weekly batch job that
extracts talks from department pages and bakes AI prerequisite/context annotations into one committed
JSON file. **Precompute-and-serve-static, full stop.** No backend, no database, near-zero cost.

## Scale (load-bearing)
A few hundred talks/semester across ~5 VT departments. The smallness is *why* there's no server and
no database. **Do not design for more.** If a suggestion only makes sense at larger scale, it's wrong
for this project.

## Hard constraints — never violate without flagging first
1. No backend server. No always-on process.
2. No database. The "database" is `data/seminars.json`, one flat file committed to the repo.
3. No scraping middleman (Firecrawl/Scrapfly/etc.). Plain HTTP GET against public `.edu` pages.
4. No live per-user endpoints, no serverless functions in v1. Everything precomputes at build time.
5. All filtering/search is client-side, over the shipped JSON.
6. Ingest runs only as a scheduled GitHub Action (weekly cron), never on the user's machine.
7. Served via GitHub Pages.
8. Plain JavaScript. No TypeScript, no transpile step, no tsconfig.

## The pipeline (this is basically the whole app)
`fetch → reduce → extract → annotate → merge → write`
1. **fetch** — plain HTTP GET. Prefer plain `fetch`; only reach for Playwright if a page truly needs
   JS to render its seminar list. Avoid the browser dependency if you can.
2. **reduce** — HTML → clean main-content text (`@mozilla/readability` + `jsdom`) *before* the LLM.
   Never feed raw HTML to the model.
3. **extract** — one Gemini call per page, `responseSchema`-constrained, returns an array of talks.
   **The main failure mode is multi-talk pages** — segment and associate fields per talk correctly.
4. **annotate** — `prerequisites`, `related_concepts`, `one_line_context`. Same call or a follow-up.
5. **merge** — combine all sources, dedupe on (title + date + speaker), assign stable ids.
6. **write** — `data/seminars.json`, committed by the Action.

## Runtime validation (the reason there's no TypeScript)
The untrusted boundary is the **LLM's output**. Enforce the schema at runtime in two layers:
- **Constrain the model:** `responseMimeType: "application/json"` + `responseSchema`.
- **Check after parsing:** light hand-rolled validator — title present, `datetime_start` parses as a
  real date, talks array non-empty, required fields non-empty. (Zod optional, not required.)

On validation failure: **retry once, then skip the page and log it. Never write unvalidated data to
`seminars.json`.**

## Extraction rules (hard-won — follow exactly)
- **DO** extract `prerequisites`, `related_concepts`, `one_line_context` (grounded in title +
  abstract).
- **DO NOT** invent a "beginner-friendly"/difficulty/accessibility rating. It depends on the
  speaker's delivery, which the abstract can't reveal. This is the single biggest hallucination risk.
- **Do not invent missing data.** No abstract / TBA speaker → the field is `null`.
- Every annotation is flagged `ai_generated: true` and shown with a **visible disclaimer** in the UI.

## Per-talk schema (canonical — see spec.md for full annotated version)
`id, title, speaker, affiliation, department, series, datetime_start, datetime_end, location,
abstract, source_url, annotations{ prerequisites[], related_concepts[], one_line_context,
ai_generated }`
Nullable-when-absent: everything except `id`, `title`, `department`, `source_url`, and `annotations`.

## Frontend / UI
The frontend is **vanilla JS + plain CSS**, bundled by Vite (dev-server/bundler only — no framework,
no TypeScript, per hard constraint #8). It loads the shipped `data/seminars.json` and does all
filtering/search/views **client-side**. Files: `web/{index.html, main.js, render.js, card.js,
calendar.js, style.css}`.

Module roles:
- `main.js` — entry point. Owns `state` (`view`, `talks`, `filters`), `load()`, `applyFilters()`,
  `render()` (dispatches by `state.view`), and the List/Calendar tab wiring.
- `render.js` — `renderRich()`: markdown + KaTeX → safe HTML for rich fields (title, abstract,
  context, prerequisites). Only rich fields go through it; plain metadata is HTML-escaped via `esc()`.
- `card.js` — the **canonical talk card** (`card()` + `esc()`), shared by the List view and the
  Calendar day panel so both render the *full* talk identically (title, speaker, meta, abstract,
  context, AI prerequisites, source). **One card renderer — never fork a second, trimmed copy.**
- `calendar.js` — `renderCalendar()`: month-grid view. Buckets an already-filtered array by local day,
  draws a 7-col grid with per-day chips (short single-line labels, math/markdown stripped), prev/Today/
  next nav, a day-detail panel that reuses `card()`, and an Undated section for null-`datetime_start`
  talks. Grid uses `grid-template-columns: repeat(7, minmax(0, 1fr))` — the `minmax(0, …)` floor is
  load-bearing: plain `1fr` lets a long title inflate its column and break the grid.

Rules:
- Both views **share one filter state** and the single `applyFilters()`. A view renders from the
  already-filtered array; **it must not re-filter.**
- Styling reuses the `:root` theme tokens (`--bg --fg --muted --border --accent` VT maroon, `--card`)
  and the `prefers-color-scheme` dark-mode override. **Don't hardcode colors.**
- Responsive: **no horizontal page scroll ≤640px.** The month grid collapses to compact dot-indicator
  cells on mobile (talks revealed via the day panel).
- The `hidden` attribute must win over any `display` rule (see `[hidden]{display:none!important}`) so
  the inactive view fully collapses.

**For ANY UI/visual/frontend work — new views, layout, styling, components, responsive/theming,
polish, copy on controls — use the `impeccable` skill.** Don't hand-roll UI ad hoc.

Verify UI changes in a real browser before calling them done: Playwright is a devDependency and drives
the Vite dev server (`npm run dev`). Check both views, light + dark, desktop + mobile, and confirm no
horizontal overflow.

## Config (churn-proofing — don't hardcode)
- Source URLs → `config/sources.json` (`{ department, series, url }`). Adding a department is one line.
- LLM model name → config/env var, NOT scattered across code. Free-tier names change often.
- Gemini API key → GitHub Actions secret `GEMINI_API_KEY`, never committed. Locally: env var.

## Eval / correctness bar (build it — don't skip)
- Hand-label expected output for **2 source pages** in `eval/expected/<source>.json`.
- `eval/run-eval.js` runs live extraction and reports **field-level accuracy** vs expected.
- **Target ~95% field accuracy** before v1 is "done."
- Measure the real failure modes: **multi-talk segmentation, date/time parsing, missing-field
  handling** — not "model intelligence." If the cheapest model clears the bar, ship it. Don't go
  shopping for a smarter model.

## Build order (do NOT try to cover everything first)
Wire up **2–3 sources** (1–2 VT Math series under `seminar.math.vt.edu`, plus the VT Statistics
colloquium under `stat.vt.edu`), get the full loop working end-to-end, pass the eval, deploy — *then*
add departments.

## Repo layout
```
config/sources.json   src/{fetch,reduce,extract,annotate,merge,ingest}.js
eval/{expected/,run-eval.js}   data/seminars.json
web/{index.html,main.js,render.js,card.js,calendar.js,style.css}
.github/workflows/ingest.yml   README.md
```

## Definition of done (v1)
- `npm run ingest` fetches sources, extracts + annotates, validates at runtime, writes
  `data/seminars.json`.
- Eval passes at ~95% field accuracy.
- Static frontend loads the JSON and filters/searches entirely client-side, with **List and Calendar
  (month-grid) views** sharing one filter state.
- A weekly-cron Action runs ingest, commits the JSON, deploys to Pages.
- README documents adding a source and running the eval.
- CLAUDE.md reflects the current code (files, module roles, conventions) — updated as part of finishing
  the task, per the "Keep this file current" rule at the top.

## NON-GOALS (actively do not build)
No database. No backend/serverless (yet). No TypeScript/build step for ingest. No live per-user
features. No non-VT universities, no generic extractor. No difficulty/beginner-friendly ratings.

## The one future feature (NOT v1 — do not build now)
A live "ask about this talk" / "personalize to my background" chat genuinely can't be precomputed
(input is the individual user). That's the one case needing a single serverless function later. The
architecture is built so it slots in cleanly — one decoupled endpoint, no rearchitecting. **Not now.**
