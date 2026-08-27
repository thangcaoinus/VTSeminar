// merge.js — combine talks from all sources, dedupe (with cross-source field-merge), assign ids.
//
// Sources are complementary, not just redundant: a live department calendar feed carries a talk's
// date + location but no abstract, while that department's archive page carries the abstract but
// often no date. So dedupe here does more than drop a copy — when two sources describe the SAME
// talk it MERGES their fields (backfilling nulls) so neither half of the information is lost.
//
// The matching is deliberately careful: it must collapse the same talk even when one source
// prefixes the title with the series name and appends "(Speaker, Affiliation)" (the calendar feed
// does), yet must NOT merge two genuinely different talks (e.g. the same speaker giving two talks
// on one day). Match key = normalized core title + calendar day; when a talk has no date at all,
// the key additionally requires a matching speaker so undated archive rows don't over-merge.

import { createHash } from 'node:crypto';

/**
 * Stable display id: hash of title + date + speaker. Same talk (post-merge) -> same id.
 * @returns {string} 16-char hex
 */
export function talkId({ title, datetime_start, speaker }) {
  const key = [title ?? '', datetime_start ?? '', speaker ?? '']
    .map((s) => String(s).trim().toLowerCase())
    .join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Normalize a title to a comparable "core" for cross-source matching: lower-case, strip a leading
 * "<Series words> Seminar/Colloquium/Series -|:" prefix and a trailing "(Speaker, Affiliation)"
 * parenthetical (both of which the calendar feed adds but the archive pages omit), and collapse
 * punctuation/whitespace. Conservative on the trailing paren: only a paren that contains a comma
 * (i.e. "Name, Affiliation") is treated as a speaker tag and stripped, so a title that genuinely
 * ends in parentheses is left intact.
 * @param {string} title
 * @returns {string}
 */
function coreTitle(title) {
  let t = String(title ?? '').trim();
  // Drop a leading series label: "… Seminar - ", "… Colloquium: ", "… Series — ", etc.
  t = t.replace(/^.*?\b(seminar|colloquium|series)\b\s*[-–—:]\s*/i, '');
  // Drop a trailing speaker parenthetical like "(Jane Doe, Virginia Tech)".
  t = t.replace(/\s*\([^)]*,[^)]*\)\s*$/, '');
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Normalize a speaker name for comparison (lower-case, collapse non-alphanumerics). */
function normSpeaker(speaker) {
  return String(speaker ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Calendar day (YYYY-MM-DD) of a datetime, or '' if absent/unparseable. */
function dayOf(datetime_start) {
  if (!datetime_start) return '';
  const s = String(datetime_start);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/**
 * Do two talks that share a core title refer to the same talk? They match when they fall on the
 * same calendar day; or, when at least one has NO date (e.g. an undated archive talk vs. a dated
 * calendar-feed talk), when their speakers match. The speaker requirement on the undated path is
 * the over-merge guard: it stops two different undated rows with the same generic title (e.g. two
 * "Applied Numerical Analysis Seminar" placeholders) from collapsing into one.
 */
function sameTalk(a, b) {
  const dayA = dayOf(a.datetime_start);
  const dayB = dayOf(b.datetime_start);
  if (dayA && dayB) return dayA === dayB;
  // at least one undated -> require a matching, non-empty speaker
  const sa = normSpeaker(a.speaker);
  const sb = normSpeaker(b.speaker);
  return sa !== '' && sa === sb;
}

/** Is a value "empty" for backfill purposes (null/undefined, blank string, empty array)? */
function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Backfill empty top-level fields and annotation fields of `base` from a later `incoming` copy of
 * the same talk. The base (an earlier, higher-priority source) keeps every non-empty value it has;
 * `incoming` only fills gaps. Never concatenates — it picks.
 */
function backfill(base, incoming) {
  for (const [k, v] of Object.entries(incoming)) {
    if (k === 'annotations') continue;
    if (isEmpty(base[k]) && !isEmpty(v)) base[k] = v;
  }
  if (incoming.annotations) {
    base.annotations = base.annotations ?? {};
    for (const [k, v] of Object.entries(incoming.annotations)) {
      if (isEmpty(base.annotations[k]) && !isEmpty(v)) base.annotations[k] = v;
    }
  }
  return base;
}

/**
 * Merge per-source talk arrays into one deduped, id-stamped array. Sources should be ordered by
 * preference — the first source to contribute a given talk owns its non-empty fields; later
 * sources backfill only what's missing. This preserves rich per-series/archive data while letting
 * a broad calendar feed supply the dates/locations those pages lack (and vice versa).
 *
 * @param {Array<{ talks: Array, source: object }>} perSource
 * @returns {Array} merged talks
 */
export function mergeTalks(perSource) {
  // Bucket candidates by normalized core title, then within a bucket merge only talks that
  // sameTalk() confirms are the same. Core title alone is too loose (a recurring series can reuse
  // a generic title), so it's a cheap pre-filter, not the match itself. Buckets preserve source
  // order, so the first (highest-priority) source owns a talk's non-empty fields.
  const buckets = new Map();
  for (const { talks, source } of perSource) {
    for (const t of talks) {
      const talk = {
        ...t,
        department: source.department,
        series: t.series ?? source.series ?? null,
        source_url: source.url,
      };
      const bucketKey = coreTitle(talk.title);
      const bucket = buckets.get(bucketKey);
      if (!bucket) {
        buckets.set(bucketKey, [talk]);
        continue;
      }
      const match = bucket.find((existing) => sameTalk(existing, talk));
      if (match) backfill(match, talk); // fill the earlier record's gaps, keep its identity
      else bucket.push(talk);
    }
  }
  // Flatten and stamp the stable display id last, from each merged record.
  const merged = [...buckets.values()].flat();
  for (const talk of merged) talk.id = talkId(talk);
  return merged;
}
