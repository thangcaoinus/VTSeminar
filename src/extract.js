// extract.js — clean text -> array of talk objects, via Gemini structured output.
//
// The untrusted boundary in this app is the LLM's output. Two layers of defense:
//   1. Constrain the model with responseSchema (schema-valid JSON at the API level).
//   2. Validate values after parsing (see validateTalks). Retry once, then skip + log.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { chunkText } from './chunk.js';

// Large pages (e.g. multi-year archives) are split into chunks of at most this many chars and
// extracted one chunk per model call, so no single JSON response overflows the output-token cap.
//
// Sizing is driven by OUTPUT, not input: each extracted talk costs ~700 output tokens (the abstract
// is echoed back plus annotations are added), so the reply is ~2x the size of the talk's input text.
// ~15K input chars ≈ ~12 talks ≈ ~8.5K output tokens per chunk — comfortably under the cap below with
// margin for abstract-heavy chunks. (An earlier 40K/8192-token combo overflowed ~3x and truncated the
// JSON mid-string; that was the ANA/CS cold-run failure.)
const CHUNK_MAX_CHARS = 15000;
// Output-token ceiling. gemini-flash-lite accepts up to 65536; use it so a chunk's JSON is never
// truncated by the cap. Overridable via env for other models.
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 65536;

/**
 * Gemini responseSchema mirroring the per-talk data schema (see spec.md / CLAUDE.md).
 * Handles pages listing MULTIPLE talks — this is the main failure mode.
 */
export const responseSchema = {
  type: 'object',
  properties: {
    talks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          speaker: { type: 'string', nullable: true },
          affiliation: { type: 'string', nullable: true },
          series: { type: 'string', nullable: true },
          datetime_start: { type: 'string', nullable: true },
          datetime_end: { type: 'string', nullable: true },
          location: { type: 'string', nullable: true },
          abstract: { type: 'string', nullable: true },
          annotations: {
            type: 'object',
            properties: {
              prerequisites: { type: 'array', items: { type: 'string' } },
              related_concepts: { type: 'array', items: { type: 'string' } },
              one_line_context: { type: 'string' },
              ai_generated: { type: 'boolean' },
            },
            required: ['prerequisites', 'related_concepts', 'one_line_context', 'ai_generated'],
          },
        },
        required: ['title', 'annotations'],
      },
    },
  },
  required: ['talks'],
};

/**
 * Light runtime validator. Returns { ok, talks, errors }.
 * Enforces: talks array non-empty; each talk has a title; datetime_start (when present)
 * parses as a real date.
 */
export function validateTalks(parsed) {
  const errors = [];
  const talks = parsed?.talks;
  if (!Array.isArray(talks) || talks.length === 0) {
    return { ok: false, talks: [], errors: ['talks array missing or empty'] };
  }
  for (const [i, t] of talks.entries()) {
    if (!t.title || !String(t.title).trim()) errors.push(`talk[${i}]: missing title`);
    if (t.datetime_start != null && Number.isNaN(Date.parse(t.datetime_start))) {
      errors.push(`talk[${i}]: datetime_start does not parse (${t.datetime_start})`);
    }
  }
  return { ok: errors.length === 0, talks, errors };
}

/**
 * Build the extraction prompt. Encodes the CLAUDE.md extraction rules directly so the
 * model is grounded and the hallucination guards are explicit.
 */
function buildPrompt(text, source) {
  return `You extract research-seminar talks from the cleaned text of a university
department web page, and annotate each with prerequisite/context info.

CONTEXT
- Department: ${source.department}
- Series: ${source.series ?? 'unknown'}
- Source URL: ${source.url}

The page may list MULTIPLE talks. Segment them and associate each field with the correct
talk. This is the most important part — do not merge distinct talks or split one talk.

FIELDS PER TALK
- title, speaker, affiliation, series, datetime_start, datetime_end, location, abstract.
- datetime_start / datetime_end: ISO 8601. Assume US Eastern time and the year shown on the
  page. If only a date is known (no time), use the date at midnight. If a talk has no real
  date (e.g. "No Seminar", "TBA", a header row), OMIT it entirely — do not invent a date.

ANNOTATIONS PER TALK (ground strictly in title + abstract)
- prerequisites: concrete topics/courses a listener should already know. [] if unknowable.
- related_concepts: adjacent topics/fields. [] if unknowable.
- one_line_context: one plain-language sentence on what the talk is about.
- ai_generated: always true.

HARD RULES
- DO NOT invent a "beginner-friendly" / difficulty / accessibility rating. It depends on the
  speaker's delivery, which the abstract cannot reveal. This is the biggest hallucination risk.
- DO NOT invent missing data. No abstract or TBA speaker -> that field is null.
- Only include real talks. Skip navigation, "No Seminar" rows, and meeting-info blurbs.
- series: use the Series given in CONTEXT above. A date, semester, or year heading (e.g. "Fall
  2023", "Spring 2025") is NOT a series name — never put one in the series field. Only override the
  given series if the page explicitly names a genuinely different seminar series for that talk.

CLEANED PAGE TEXT
"""
${text}
"""`;
}

/**
 * One model call: returns the parsed { talks } object (unvalidated).
 */
async function callGemini(text, source, opts) {
  const genAI = new GoogleGenerativeAI(opts.apiKey);
  const model = genAI.getGenerativeModel({
    model: opts.model,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  });
  const result = await model.generateContent(buildPrompt(text, source));
  const raw = result.response.text();
  return JSON.parse(raw);
}

/**
 * Extract talks from ONE chunk of reduced text. Retries the model call once on validation
 * failure, then throws so the caller can skip the chunk (or page).
 * @param {string} text     reduced text (a whole small page, or one chunk of a large one)
 * @param {object} source   { department, series, url }
 * @param {object} opts      { model, apiKey }
 * @returns {Promise<Array>} validated talk objects (pre-merge; no ids/department yet)
 */
async function extractChunk(text, source, opts) {
  let lastErrors = ['unknown'];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const parsed = await callGemini(text, source, opts);
      const { ok, talks, errors } = validateTalks(parsed);
      if (ok) {
        // Belt-and-suspenders: force ai_generated true on every annotation.
        for (const t of talks) {
          t.annotations = { ...t.annotations, ai_generated: true };
        }
        return talks;
      }
      lastErrors = errors;
    } catch (err) {
      lastErrors = [err.message];
    }
    if (attempt === 1) console.warn(`  retry ${source.url}: ${lastErrors.join('; ')}`);
  }
  throw new Error(`extraction failed after retry: ${lastErrors.join('; ')}`);
}

/**
 * Extract all talks from a page's reduced text. Small pages are a single call (unchanged).
 * Large pages are split into size-bounded chunks and extracted one chunk per call, then
 * concatenated — this keeps each JSON response small enough to avoid output-token truncation.
 *
 * Partial-failure policy: a chunk that fails after its retry is skipped and logged, but the
 * talks from every other chunk are kept. Only if EVERY chunk fails do we throw, so the caller
 * skips the whole page (preserving the "never write from a failed page" guarantee).
 *
 * @param {string} text     reduced page text
 * @param {object} source   { department, series, url }
 * @param {object} opts      { model, apiKey }
 * @returns {Promise<Array>} validated talk objects (pre-merge; deduped globally by merge.js)
 */
export async function extractTalks(text, source, opts) {
  const chunks = chunkText(text, { maxChars: CHUNK_MAX_CHARS });
  if (chunks.length === 1) return extractChunk(chunks[0], source, opts);

  const all = [];
  let failures = 0;
  for (const [i, chunk] of chunks.entries()) {
    try {
      all.push(...(await extractChunk(chunk, source, opts)));
    } catch (err) {
      failures++;
      console.warn(`  chunk ${i + 1}/${chunks.length} ${source.url}: ${err.message}`);
    }
  }
  if (all.length === 0) {
    throw new Error(`all ${chunks.length} chunks failed for ${source.url}`);
  }
  if (failures) {
    console.warn(
      `  ${source.url}: ${failures}/${chunks.length} chunks skipped, kept ${all.length} talks`,
    );
  }
  return all;
}
