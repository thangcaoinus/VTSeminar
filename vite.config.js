import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const dataFile = resolve(rootDir, 'data/seminars.json');

// Vite serves ONLY the static frontend in web/. The ingest pipeline (src/) is plain
// Node ESM with no build step and is never touched by Vite.
//
// data/seminars.json is the committed "database" at the repo root. The frontend always
// fetches it at the relative path ./data/seminars.json. This tiny plugin wires that path
// up in both modes:
//   - dev:   a middleware serves the repo-root file at /data/seminars.json
//   - build: the file is copied into dist/data/seminars.json
// One fetch path, works in dev, preview, and GitHub Pages.
function serveDataFile() {
  return {
    name: 'serve-seminars-data',
    configureServer(server) {
      server.middlewares.use('/data/seminars.json', (_req, res) => {
        if (!existsSync(dataFile)) {
          res.statusCode = 404;
          res.end('seminars.json not found — run `npm run ingest` first');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(readFileSync(dataFile));
      });
    },
    closeBundle() {
      if (!existsSync(dataFile)) return;
      const outDir = resolve(rootDir, 'dist/data');
      mkdirSync(outDir, { recursive: true });
      copyFileSync(dataFile, resolve(outDir, 'seminars.json'));
    },
  };
}

export default defineConfig({
  root: resolve(rootDir, 'web'),
  publicDir: false,
  plugins: [serveDataFile()],
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: true,
  },
  server: { port: 5173 },
});
