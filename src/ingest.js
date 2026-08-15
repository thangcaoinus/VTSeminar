// ingest.js — orchestrates fetch -> reduce -> extract -> annotate -> merge -> write.
// Entry point for `npm run ingest`. Run weekly by the GitHub Action, never on the user's machine.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fetchPage } from './fetch.js';
import { reduceHtml } from './reduce.js';
import { extractTalks } from './extract.js';
import { mergeTalks } from './merge.js';

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
  const perSource = [];

  for (const source of config.sources) {
    try {
      const html = await fetchPage(source.url);
      const text = reduceHtml(html, source.url);
      const talks = await extractTalks(text, source, { model, apiKey });
      perSource.push({ talks, source });
      console.log(`ok   ${source.url} -> ${talks.length} talks`);
    } catch (err) {
      // Never write unvalidated data: on failure, skip the page and log it.
      console.error(`skip ${source.url}: ${err.message}`);
    }
  }

  const talks = mergeTalks(perSource);
  const outPath = resolve(rootDir, 'data/seminars.json');
  await writeFile(outPath, JSON.stringify(talks, null, 2) + '\n', 'utf8');
  console.log(`wrote ${talks.length} talks -> data/seminars.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
