// ingest.js — orchestrates fetch -> reduce -> extract -> annotate -> merge -> write.
// Entry point for `npm run ingest`. Run weekly by the GitHub Action, never on the user's machine.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fetchPage } from './fetch.js';
import { reduceHtml } from './reduce.js';
import { extractTalks } from './extract.js';
import { mergeTalks } from './merge.js';
import { loadCache, saveCache, hashText } from './cache.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

async function loadConfig() {
  const raw = await readFile(resolve(rootDir, 'config/sources.json'), 'utf8');
  return JSON.parse(raw);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set. Aborting.');
    process.exit(1);
  }

  const config = await loadConfig();
  const model = process.env.GEMINI_MODEL || config.model;
  const cache = await loadCache(rootDir);
  const perSource = [];

  for (const source of config.sources) {
    try {
      const html = await fetchPage(source.url);
      const text = reduceHtml(html, source.url);
      const hash = hashText(text);

      // Reuse the prior extraction when the reduced page text is unchanged — this skips the
      // Gemini call entirely, the dominant cost of a run.
      const cached = cache.entries[source.url];
      let talks;
      if (cached && cached.hash === hash) {
        talks = cached.talks;
        console.log(`cache ${source.url} -> ${talks.length} talks`);
      } else {
        talks = await extractTalks(text, source, { model, apiKey });
        cache.entries[source.url] = { hash, talks };
        console.log(`ok    ${source.url} -> ${talks.length} talks`);
      }
      perSource.push({ talks, source });
    } catch (err) {
      // Never write unvalidated data: on failure, skip the page and log it. Any existing cache
      // entry for this url is left intact — don't overwrite good data with a failure.
      console.error(`skip  ${source.url}: ${err.message}`);
    }
  }

  await saveCache(rootDir, cache);

  const talks = mergeTalks(perSource);
  const outPath = resolve(rootDir, 'data/seminars.json');
  await writeFile(outPath, JSON.stringify(talks, null, 2) + '\n', 'utf8');
  console.log(`wrote ${talks.length} talks -> data/seminars.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
