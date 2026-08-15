// run-eval.js — runs live extraction on ground-truth pages and reports field-level accuracy.
//
// Target: ~95% field accuracy before v1 is "done". Measures the REAL failure modes:
// multi-talk segmentation, date/time parsing, missing-field handling — not "model intelligence".
//
// Ground truth: eval/expected/<source>.json holds the hand-labeled expected talks for a page.
//
// TODO(build): implement once extract.js is wired. Scaffold only for now.

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

async function main() {
  const expectedDir = resolve(rootDir, 'eval/expected');
  let files = [];
  try {
    files = (await readdir(expectedDir)).filter((f) => f.endsWith('.json'));
  } catch {
    // directory may be empty during scaffold
  }
  if (files.length === 0) {
    console.log('No ground-truth files in eval/expected/. Add <source>.json first.');
    return;
  }
  console.log(`Found ${files.length} ground-truth file(s): ${files.join(', ')}`);
  console.log('eval not implemented yet (scaffold) — wire extract.js first.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
