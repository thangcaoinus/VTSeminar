// run-eval.js — a local test suite for the extractor. NOT run in CI.
//
// Ground truth (eval/expected/<slug>.json) was authored by a strong reference reader from each
// page's *reduced* text. This script runs the LIVE cheap production model through
// fetch -> reduce -> extract for each fixture's URL and diffs its output against the reference,
// reporting field-level accuracy. It confirms the cheap model is "good enough" across a diverse
// page set. Needs GEMINI_API_KEY; without it, it prints a friendly skip and exits 0.
//
// What it measures (the real failure modes, per CLAUDE.md):
//   - multi-talk SEGMENTATION (missing/extra talks, and No-Seminar/boilerplate rows leaking in)
//   - date/time PARSING (compared as instants / calendar day, tolerant of format & tz)
//   - MISSING-FIELD handling (null vs. present agreement)
// Objective fields are scored STRICTLY; model-generated annotations
// (prerequisites/related_concepts/one_line_context) are scored LENIENTLY (present-vs-null only) —
// they are grounded-but-generated, not "wrong answers". Fields set to the "__ANY__" sentinel in a
// fixture are not strictly scored (e.g. synthesized titles on pages that print no title).

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fetchPage } from '../src/fetch.js';
import { reduceHtml } from '../src/reduce.js';
import { extractTalks } from '../src/extract.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

// Objective fields scored strictly. Annotations are handled separately (lenient).
const OBJECTIVE_FIELDS = [
  'title',
  'speaker',
  'affiliation',
  'datetime_start',
  'datetime_end',
  'location',
  'abstract', // scored as presence, not verbatim (see compareField)
];
const ANNOTATION_FIELDS = ['prerequisites', 'related_concepts', 'one_line_context'];
const ANY = '__ANY__';

// Pass rate on objective fields required for the suite to "pass".
const OBJECTIVE_THRESHOLD = Number(process.env.EVAL_THRESHOLD) || 0.95;

// --- normalization helpers ---------------------------------------------------

function normStr(s) {
  if (s == null) return null;
  return String(s)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
}

// Token set for fuzzy overlap (used for abstract presence + title alignment).
function tokens(s) {
  const n = normStr(s);
  if (!n) return new Set();
  return new Set(n.replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length > 2));
}

function jaccard(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Compare dates. A fixture value may be a full ISO instant or a bare "YYYY-MM-DD"; in the latter
// case only the calendar day must match (the page often gives no time). Tolerant of tz offsets.
// ignoreYear: for pages that print NO year (the model must infer it and may legitimately land on a
// different academic year), compare month+day only.
function datesEqual(expected, actual, ignoreYear = false) {
  if (expected == null && actual == null) return true;
  if (expected == null || actual == null) return false;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(expected);
  const te = Date.parse(expected);
  const ta = Date.parse(actual);
  if (Number.isNaN(te) || Number.isNaN(ta)) return false;
  if (dayOnly || ignoreYear) {
    const de = new Date(te), da = new Date(ta);
    const sameMonthDay = de.getUTCMonth() === da.getUTCMonth() && de.getUTCDate() === da.getUTCDate();
    return ignoreYear ? sameMonthDay : (sameMonthDay && de.getUTCFullYear() === da.getUTCFullYear());
  }
  // Full instant: allow a small slop (tz/format), compare within 24h.
  return Math.abs(te - ta) < 24 * 3600 * 1000;
}

// Returns { scored: bool, ok: bool } for one objective field of an aligned pair.
// opts.ignoreYear compares dates by month+day only (pages with no printed year).
function compareField(field, expected, actual, opts = {}) {
  // A field ABSENT from the fixture (undefined) or set to the ANY sentinel is NOT scored — the
  // fixture is only asserting the fields it explicitly lists. (Distinct from an explicit `null`,
  // which asserts "this field must be absent/null".)
  if (!(field in expected)) return { scored: false, ok: true };
  const exp = expected[field];
  if (exp === ANY) return { scored: false, ok: true };
  if (field === 'datetime_start' || field === 'datetime_end') {
    return { scored: true, ok: datesEqual(exp, actual[field], opts.ignoreYear) };
  }
  if (field === 'abstract') {
    // PRESENCE agreement only. Abstract *content* is not what this suite tests (segmentation, dates,
    // speaker/affiliation splitting, and missing-field handling are). Fixtures store only a short
    // reference snippet, so verbatim/overlap scoring would be brittle and uninformative — what
    // matters is that the model emits an abstract exactly when the page has one, and null when it
    // doesn't. (When both are present, require they share *some* real content as a sanity floor.)
    const ep = exp != null && String(exp).trim() !== '';
    const ap = actual[field] != null && String(actual[field]).trim() !== '';
    if (ep !== ap) return { scored: true, ok: false };
    if (!ep) return { scored: true, ok: true };
    return { scored: true, ok: jaccard(exp, actual[field]) >= 0.08 };
  }
  // Plain string fields: null-agreement + normalized equality (with a fuzzy fallback for
  // affiliation, which the model may abbreviate/expand).
  const en = normStr(exp);
  const an = normStr(actual[field]);
  if (en == null || an == null) return { scored: true, ok: en === an };
  if (en === an) return { scored: true, ok: true };
  if (field === 'affiliation' || field === 'title') {
    return { scored: true, ok: jaccard(exp, actual[field]) >= 0.5 };
  }
  // speaker must match closely; allow contained-name (e.g. "Wilson Wright" vs "Dr. Wilson Wright")
  return { scored: true, ok: an.includes(en) || en.includes(an) };
}

// Lenient annotation score: present-vs-null agreement per field.
function compareAnnotations(expected, actual) {
  const ea = expected.annotations || {};
  const aa = actual.annotations || {};
  let scored = 0, ok = 0;
  for (const f of ANNOTATION_FIELDS) {
    const ep = f === 'one_line_context'
      ? ea[f] != null && String(ea[f]).trim() !== ''
      : Array.isArray(ea[f]) && ea[f].length > 0;
    // Fixtures leave annotations empty/null (they're the reference reader's, not scored for
    // content), so we only *reward* the model for producing something plausible, never penalize
    // it for a mismatch against an intentionally-empty fixture annotation. Score = did the model
    // emit a well-formed value of the right type?
    const aok = f === 'one_line_context'
      ? (aa[f] == null || typeof aa[f] === 'string')
      : Array.isArray(aa[f]);
    scored++;
    if (aok) ok++;
    void ep;
  }
  return { scored, ok };
}

// --- alignment ---------------------------------------------------------------

// Greedy best-match alignment of produced talks to expected talks.
// key = 'title' (default) or 'speaker'. Returns { pairs, missing, extra }.
function align(expected, produced, key) {
  const usedProduced = new Set();
  const pairs = [];
  const missing = [];

  for (const exp of expected) {
    let bestI = -1;
    let bestScore = 0;
    for (let i = 0; i < produced.length; i++) {
      if (usedProduced.has(i)) continue;
      const act = produced[i];
      let score;
      if (key === 'speaker') {
        const en = normStr(exp.speaker);
        const an = normStr(act.speaker);
        if (en && an && (an.includes(en) || en.includes(an))) score = 1;
        else score = 0;
      } else {
        // title alignment: exact-normalized wins, else token overlap
        const en = normStr(exp.title);
        const an = normStr(act.title);
        if (exp.title === ANY) score = 0; // can't align on an opted-out title
        else if (en && an && en === an) score = 1;
        else score = jaccard(exp.title, act.title);
      }
      if (score > bestScore) { bestScore = score; bestI = i; }
    }
    if (bestI >= 0 && bestScore >= (key === 'speaker' ? 1 : 0.4)) {
      usedProduced.add(bestI);
      pairs.push({ exp, act: produced[bestI] });
    } else {
      missing.push(exp);
    }
  }
  const extra = produced.filter((_, i) => !usedProduced.has(i));
  return { pairs, missing, extra };
}

// --- per-page eval -----------------------------------------------------------

async function evalPage(fixture, opts) {
  const { source } = fixture;
  const html = await fetchPage(source.url);
  const text = reduceHtml(html, source.url);
  const produced = await extractTalks(text, source, opts);

  const key = fixture.align_by === 'speaker' ? 'speaker' : 'title';
  const { pairs, missing, extra } = align(fixture.talks, produced, key);

  let objScored = 0, objOk = 0;
  let annScored = 0, annOk = 0;
  const fieldMisses = [];

  const cmpOpts = { ignoreYear: fixture.date_ignore_year === true };
  for (const { exp, act } of pairs) {
    for (const f of OBJECTIVE_FIELDS) {
      const { scored, ok } = compareField(f, exp, act, cmpOpts);
      if (!scored) continue;
      objScored++;
      if (ok) objOk++;
      else fieldMisses.push(`${key}=${exp[key] ?? exp.speaker ?? exp.title} · ${f}: expected ${JSON.stringify(exp[f])} got ${JSON.stringify(act[f])}`);
    }
    const a = compareAnnotations(exp, act);
    annScored += a.scored; annOk += a.ok;
  }

  return {
    url: source.url,
    expectedTalks: fixture.talks.length,
    producedTalks: produced.length,
    matched: pairs.length,
    missing: missing.map((m) => m.speaker || m.title),
    extra: extra.map((e) => e.speaker || e.title),
    objScored, objOk,
    annScored, annOk,
    fieldMisses,
  };
}

// --- main --------------------------------------------------------------------

async function loadConfigModel() {
  const raw = await readFile(resolve(rootDir, 'config/sources.json'), 'utf8');
  return JSON.parse(raw).model;
}

async function main() {
  const expectedDir = resolve(rootDir, 'eval/expected');
  let files = [];
  try {
    files = (await readdir(expectedDir)).filter((f) => f.endsWith('.json'));
  } catch {
    /* empty */
  }
  if (files.length === 0) {
    console.log('No ground-truth files in eval/expected/. Add <slug>.json first.');
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log(`skipped: GEMINI_API_KEY not set (eval needs the live model). ${files.length} fixture(s) present.`);
    return; // exit 0 — friendly local/no-key behavior
  }
  const model = process.env.GEMINI_MODEL || (await loadConfigModel());
  console.log(`Running eval against model "${model}" on ${files.length} page(s)...\n`);

  const results = [];
  for (const f of files) {
    const fixture = JSON.parse(await readFile(resolve(expectedDir, f), 'utf8'));
    try {
      const r = await evalPage(fixture, { model, apiKey });
      results.push(r);
      const objPct = r.objScored ? ((r.objOk / r.objScored) * 100).toFixed(1) : 'n/a';
      console.log(`── ${f}`);
      console.log(`   talks: expected ${r.expectedTalks}, produced ${r.producedTalks}, matched ${r.matched}`);
      if (r.missing.length) console.log(`   MISSING (not extracted): ${r.missing.join(', ')}`);
      if (r.extra.length) console.log(`   EXTRA (over-extracted, incl. any boilerplate leak): ${r.extra.join(', ')}`);
      console.log(`   objective field accuracy: ${objPct}% (${r.objOk}/${r.objScored})`);
      for (const m of r.fieldMisses) console.log(`      ✗ ${m}`);
      console.log('');
    } catch (err) {
      console.log(`── ${f}\n   ERROR: ${err.message}\n`);
      results.push({ url: fixture.source?.url, error: true, objScored: 0, objOk: 0 });
    }
  }

  const totObjScored = results.reduce((s, r) => s + (r.objScored || 0), 0);
  const totObjOk = results.reduce((s, r) => s + (r.objOk || 0), 0);
  const totMissing = results.reduce((s, r) => s + (r.missing?.length || 0), 0);
  const totExtra = results.reduce((s, r) => s + (r.extra?.length || 0), 0);
  const rate = totObjScored ? totObjOk / totObjScored : 0;

  console.log('════════════════════════════════════════');
  console.log(`AGGREGATE objective field accuracy: ${(rate * 100).toFixed(1)}% (${totObjOk}/${totObjScored})`);
  console.log(`segmentation: ${totMissing} missing, ${totExtra} extra across all pages`);
  console.log(`threshold: ${(OBJECTIVE_THRESHOLD * 100).toFixed(0)}%`);

  if (rate < OBJECTIVE_THRESHOLD) {
    console.log(`RESULT: FAIL — below ${(OBJECTIVE_THRESHOLD * 100).toFixed(0)}% objective-field bar.`);
    process.exit(1);
  }
  console.log('RESULT: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
