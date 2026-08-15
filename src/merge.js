// merge.js — combine talks from all sources, dedupe, assign stable ids.

import { createHash } from 'node:crypto';

/**
 * Stable id: hash of title + date + speaker. Same talk from two sources -> same id.
 * @returns {string} 16-char hex
 */
export function talkId({ title, datetime_start, speaker }) {
  const key = [title ?? '', datetime_start ?? '', speaker ?? '']
    .map((s) => String(s).trim().toLowerCase())
    .join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Merge per-source talk arrays into one deduped, id-stamped array.
 * @param {Array<{ talks: Array, source: object }>} perSource
 * @returns {Array} merged talks
 */
export function mergeTalks(perSource) {
  const byId = new Map();
  for (const { talks, source } of perSource) {
    for (const t of talks) {
      const talk = {
        ...t,
        department: source.department,
        series: t.series ?? source.series ?? null,
        source_url: source.url,
      };
      talk.id = talkId(talk);
      // First writer wins on dedupe; assumes sources are ordered by preference.
      if (!byId.has(talk.id)) byId.set(talk.id, talk);
    }
  }
  return [...byId.values()];
}
