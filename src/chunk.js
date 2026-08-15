// chunk.js — split reduced page text into size-bounded pieces for per-chunk extraction.
//
// Why: a single Gemini call must emit every talk on the page as one JSON array. A large
// archive (e.g. the ANA seminar, ~180KB / 155 talks) overflows the model's output-token cap
// and the JSON reply is truncated mid-string. Splitting the input so each call returns a
// smaller array keeps every response well-formed. This is generic and size-based — no
// page-specific heuristics.

const DEFAULT_MAX_CHARS = 40000;

/**
 * Split text into chunks no larger than maxChars, breaking only at line boundaries so a
 * talk block is never cut in half. reduce.js already emits newline-delimited block text, so
 * lines are the natural, safe split points.
 *
 * Guarantees: joining the returned chunks with '\n' reproduces the input lines in order (no
 * line dropped or duplicated). A single line longer than maxChars becomes its own oversized
 * chunk rather than being split.
 *
 * @param {string} text            reduced page text (newline-delimited)
 * @param {object} [opts]
 * @param {number} [opts.maxChars] soft upper bound on chunk length
 * @returns {string[]} one or more chunks; always at least one (possibly empty for empty input)
 */
export function chunkText(text, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (text.length <= maxChars) return [text];

  const lines = text.split('\n');
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const line of lines) {
    // +1 accounts for the '\n' that will rejoin this line to the previous one.
    const add = line.length + (current.length ? 1 : 0);
    if (current.length && currentLen + add > maxChars) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += current.length === 1 ? line.length : add;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}
