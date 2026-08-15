// check-data.js — deterministic CI deploy guard for data/seminars.json.
//
// Runs in the ingest Action AFTER ingest writes seminars.json and BEFORE the commit/build/deploy
// steps. If any assertion fails it exits non-zero, so the job stops before bad data is committed or
// deployed — a collapsed or malformed extraction never ships. NO LLM here; purely mechanical.
//
// Assertions:
//   1. seminars.json parses and is a non-empty array.
//   2. validateTalks(...) passes (reuse the real runtime validator: title present, dates parse).
//   3. Every talk has non-null id, title, department, source_url (the non-nullable schema fields).
//   4. Talk count hasn't collapsed vs. the committed HEAD copy (>= COLLAPSE_FLOOR of prior count) —
//      guards against a run where most sources failed and merge produced a near-empty file.
//
// Usage: node scripts/check-data.js [path-to-seminars.json]
//   Defaults to data/seminars.json. In CI, run it right after `npm run ingest`.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateTalks } from '../src/extract.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const COLLAPSE_FLOOR = Number(process.env.CHECK_COLLAPSE_FLOOR) || 0.5;

function fail(msg) {
  console.error(`check-data: FAIL — ${msg}`);
  process.exit(1);
}

function priorCount() {
  // Committed HEAD copy of the same file. Absent (first commit) -> no floor check.
  try {
    const raw = execSync('git show HEAD:data/seminars.json', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.length : null;
  } catch {
    return null; // no HEAD version, or not a git repo — skip the collapse check
  }
}

function main() {
  const path = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(rootDir, 'data/seminars.json');

  let talks;
  try {
    talks = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`could not read/parse ${path}: ${err.message}`);
  }

  // 1. non-empty array
  if (!Array.isArray(talks) || talks.length === 0) {
    fail('seminars.json is not a non-empty array');
  }

  // 2. reuse the real runtime validator (title present, datetime_start parses)
  const { ok, errors } = validateTalks({ talks });
  if (!ok) {
    fail(`validateTalks rejected the data:\n  - ${errors.slice(0, 10).join('\n  - ')}`);
  }

  // 3. non-nullable fields present on every merged talk
  const required = ['id', 'title', 'department', 'source_url'];
  const bad = [];
  talks.forEach((t, i) => {
    for (const f of required) {
      if (t[f] == null || String(t[f]).trim() === '') bad.push(`talk[${i}] missing ${f}`);
    }
  });
  if (bad.length) {
    fail(`${bad.length} talk(s) missing required fields:\n  - ${bad.slice(0, 10).join('\n  - ')}`);
  }

  // 4. collapse guard vs. committed HEAD
  const prior = priorCount();
  if (prior != null && prior > 0) {
    const floor = Math.floor(prior * COLLAPSE_FLOOR);
    if (talks.length < floor) {
      fail(`talk count collapsed: ${talks.length} < ${floor} (${(COLLAPSE_FLOOR * 100).toFixed(0)}% of prior ${prior}). Likely a mass source failure — refusing to deploy.`);
    }
    console.log(`check-data: count ${talks.length} (prior ${prior}, floor ${floor}) OK`);
  } else {
    console.log(`check-data: count ${talks.length} (no prior HEAD copy — collapse check skipped)`);
  }

  console.log(`check-data: PASS — ${talks.length} talks, all required fields present, validator OK.`);
}

main();
