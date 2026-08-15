// cache.js — a committed, content-hash extraction cache so ingest skips the Gemini call
// for pages whose reduced text is unchanged since the last run.
//
// The cache unit is per-source extraction output (annotations are part of the extract call,
// see extract.js). Key = source.url; validity = stored hash equals sha256(current reduced text).
// Only VALIDATED extraction output is ever stored (ingest caches the result of extractTalks,
// which validates + retries), so we never persist unvalidated model output.
//
// The "database" stays a flat committed JSON file, per the project's hard constraints.

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Bump when extraction logic changes (prompt in extract.js, responseSchema, or the validator)
// so stale cached talks are discarded and every page re-extracts. A version mismatch in the
// on-disk file makes loadCache() return an empty cache.
export const CACHE_VERSION = 2;

const CACHE_FILE = 'data/extract-cache.json';

/** sha256 hex of a string (same crypto pattern as merge.js:talkId). */
export function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** An empty, current-version cache. */
function emptyCache() {
  return { version: CACHE_VERSION, entries: {} };
}

/**
 * Load the extraction cache. Returns an empty cache if the file is missing, unparseable,
 * or written by a different CACHE_VERSION (so a logic change re-extracts everything).
 * @param {string} rootDir repo root
 * @returns {Promise<{version:number, entries:Object}>}
 */
export async function loadCache(rootDir) {
  try {
    const raw = await readFile(resolve(rootDir, CACHE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== 'object' || !parsed.entries) {
      return emptyCache();
    }
    return parsed;
  } catch {
    return emptyCache();
  }
}

/**
 * Write the cache back to disk (pretty JSON + trailing newline, matching ingest.js).
 * @param {string} rootDir repo root
 * @param {{version:number, entries:Object}} cache
 */
export async function saveCache(rootDir, cache) {
  const outPath = resolve(rootDir, CACHE_FILE);
  await writeFile(outPath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
}
