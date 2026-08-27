// calendar-feed.js — fetch + reduce for a VT "Pamplin calendar widget" JSON feed.
//
// Some VT department pages (e.g. math.vt.edu/calendar.html) don't server-render their seminar
// list: they mount `<calendar data-calendarid="…">` and a widget script injects the events with
// JS. That page reduces to a masthead only, and the widget itself FAILS headless (it needs
// jQuery), so Playwright doesn't help — the pipeline rule "avoid the browser dependency" stands.
//
// But the widget just reads a PUBLIC STATIC JSON feed, which a plain `fetch` retrieves directly:
//   https://pamplinstorage.blob.core.windows.net/calendarwidget-v2/<calendarid>.json
// So this module is the fetch+reduce EQUIVALENT of fetch.js+reduce.js for that feed: it returns
// the same clean, line-delimited text contract that extractTalks() consumes, keyed per source.url.
// (Discover a department's calendarid from the registry `.../calendarwidget-v2/calendars.json`.)

import { JSDOM } from 'jsdom';

const FEED_BASE = 'https://pamplinstorage.blob.core.windows.net/calendarwidget-v2';

/**
 * The public JSON feed URL for a given Pamplin calendar id.
 * @param {string} calendarid
 * @returns {string}
 */
export function feedUrl(calendarid) {
  return `${FEED_BASE}/${calendarid}.json`;
}

/**
 * Fetch and parse a calendar feed. Plain HTTP GET, browser-free (satisfies the "no scraping
 * middleman / plain fetch" hard constraint). Throws on a bad response or an unexpected payload
 * shape, so the ingest loop treats it as a skippable page rather than writing empty data.
 * @param {string} calendarid
 * @returns {Promise<Array<object>>} raw event objects
 */
export async function fetchCalendarFeed(calendarid) {
  const url = feedUrl(calendarid);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'vt-seminars-aggregator (personal, non-commercial)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(`calendar feed ${url} was not a non-empty array`);
  }
  return events;
}

/** Strip an HTML fragment to plain, whitespace-collapsed text (feed titles/descriptions are HTML). */
function stripHtml(html) {
  if (!html) return '';
  const { document } = new JSDOM(String(html)).window;
  return (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Flatten a feed event's `title` to plain text: turn the `<br/>` (which separates a series line
 * from a speaker parenthetical, e.g. `Applied Numerical Analysis Seminar<br/>(Daniel Appelö, VT)`)
 * into a dash separator, then strip any residual HTML.
 * @param {string} rawTitle
 * @returns {string}
 */
export function flattenTitle(rawTitle) {
  const dashed = String(rawTitle ?? '').replace(/<br\s*\/?>/gi, ' - ');
  return stripHtml(dashed);
}

/**
 * Given a flattened title and a series map ({ prefix: seriesName }), return the mapped series if
 * the title starts with a known prefix, else null. Used both to emit an explicit `Series:` hint
 * for extraction AND (re-exported) to normalize titles for cross-source dedupe in merge.js — so
 * the two never drift. Longest prefix wins (defensive against one prefix being a prefix of another).
 * @param {string} flatTitle  a title already run through flattenTitle()
 * @param {Object<string,string>} [seriesMap]
 * @returns {{ prefix: string, series: string } | null}
 */
export function matchSeriesPrefix(flatTitle, seriesMap = {}) {
  const lower = String(flatTitle ?? '').toLowerCase();
  let best = null;
  for (const [prefix, series] of Object.entries(seriesMap)) {
    const p = prefix.toLowerCase();
    if (lower.startsWith(p) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, series };
    }
  }
  return best;
}

/**
 * Remove a leading series label (and the "-"/":"/"—" that follows it) from a flattened title, so
 * the emitted title is the talk itself, not "Series - Talk". Falls back to the series prefix when
 * the remainder is empty or only a "(Speaker, Affiliation)" tag — i.e. a scheduled slot that has
 * no talk title yet — so the row still carries a sensible, non-empty title.
 * @param {string} flatTitle  a title already run through flattenTitle()
 * @param {string} prefix     the matched series prefix (from matchSeriesPrefix)
 * @returns {string}
 */
export function stripSeriesPrefix(flatTitle, prefix) {
  const t = String(flatTitle ?? '');
  const rest = t
    .slice(prefix.length)
    .replace(/^\s*[-–—:]\s*/, '')
    .trim();
  if (rest === '') return prefix; // no talk title at all -> just the series name
  // Only a "(Speaker, Affiliation)" tag left: there's no real talk title yet, but keep the speaker
  // so extraction can still read it — just drop the redundant "-" so it reads "Series (Speaker)".
  if (/^\([^)]*\)$/.test(rest)) return `${prefix} ${rest}`;
  return rest;
}

/**
 * Reduce a calendar feed's events to clean, line-delimited text mirroring reduce.js's output, so
 * extractTalks() can segment + annotate them exactly like a reduced HTML page. One labeled block
 * per event, blank-line separated.
 *
 * Deliberately DUMB (no page-specific heuristics, matching reduce.js/chunk.js): it does NOT
 * pre-filter all-day / non-talk rows and does NOT surgically extract the speaker — the extract
 * prompt already skips nav/"No Seminar"/undated rows and lifts speakers from title parentheticals.
 * The one bit of grounding it adds is an explicit `Series:` line WHEN the title matches a known
 * series prefix (from seriesMap); on a miss it emits no Series line, so the talk falls back to the
 * model + the source's default series. That keeps the series mapping robust, not brittle.
 *
 * Timezone: emit `startEST`/`endEST` (bare local Eastern wall-clock), NOT `start`/`end` (which are
 * Z-suffixed UTC) — the extract prompt assumes US Eastern, so feeding UTC would double-shift.
 *
 * @param {Array<object>} events        raw feed events
 * @param {Object<string,string>} [seriesMap]  { titlePrefix: seriesName }
 * @returns {string} clean line-delimited text
 */
export function reduceCalendarEvents(events, seriesMap = {}) {
  const blocks = [];
  for (const e of events) {
    const title = flattenTitle(e.title);
    if (!title) continue; // nothing to extract from a titleless row

    const lines = [];
    const hit = matchSeriesPrefix(title, seriesMap);
    let displayTitle = title;
    if (hit) {
      lines.push(`Series: ${hit.series}`);
      // The feed bakes the series name into the title (e.g. "Applied Algebra Seminar - Real
      // Title (Speaker)"); drop that redundant prefix so the extracted title is just the talk.
      // If nothing meaningful remains (many rows are only "Series - (Speaker)" placeholders with
      // no talk title yet), keep the series name as the title rather than emitting an empty one.
      displayTitle = stripSeriesPrefix(title, hit.prefix);
    }
    lines.push(`Title: ${displayTitle}`);

    const start = trimEasternStamp(e.startEST);
    const end = trimEasternStamp(e.endEST);
    if (start) lines.push(`When: ${start}${end ? ` to ${end}` : ''}`);
    if (e.isAllDay === true || e.isAllDay === 'true') lines.push('All-day event');

    const location = stripHtml(e.location);
    if (location) lines.push(`Location: ${location}`);

    const description = stripHtml(e.description);
    if (description) lines.push(`Description: ${description}`);

    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n').trim();
}

/** Trim the feed's 7-digit fractional seconds (`2026-08-31T12:15:00.0000000` -> `…T12:15:00`). */
function trimEasternStamp(s) {
  if (!s) return '';
  return String(s).replace(/\.0+$/, '').trim();
}
