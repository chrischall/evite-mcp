#!/usr/bin/env node
// Discovery spike harness for evite-mcp (Plan 1, Task 4).
//
// Maps Evite's *internal* web API by lifting your signed-in evite.com session
// from a browser tab (via @fetchproxy/bootstrap) and recording the requests the
// site's own frontend makes. Evite has no public API, so this is how we learn
// the real endpoints/payloads that the MCP's tools will call.
//
// PREREQUISITES (this is interactive — it cannot run headless):
//   1. A signed-in evite.com tab open in your browser.
//   2. The fetchproxy browser extension installed and connected, so this
//      process's one-shot bridge can reach the tab.
//
// USAGE:
//   node scripts/spike-capture.mjs --probe
//       Confirm the bridge connects and print the captured COOKIE NAMES (not
//       values). Use this first to verify connectivity + learn the session
//       cookie/token names (fill them into the `declare.cookies` list below).
//
//   node scripts/spike-capture.mjs --capture urls.txt
//       For each URL in urls.txt (one per line — the internal API calls you
//       observed in DevTools → Network while using the site), fetch it with the
//       lifted session and write a SCRUBBED fixture to tests/fixtures/.
//
// OUTPUT: tests/fixtures/<slug>.json (PII-scrubbed) + you then hand-write
// docs/EVITE-API.md from what you observe.
//
// SECURITY: the `declare.cookies` list is the boundary — only declared cookies
// are lifted. Fixtures are scrubbed (emails/names/tokens → placeholders) before
// being written. Never commit a fixture containing a real token or email.

import { bootstrap } from '@fetchproxy/bootstrap';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');

// TODO(spike): replace with the real evite.com session cookie/token names you
// see in `--probe` output / DevTools → Application → Cookies. Start broad.
const DECLARE_COOKIES = ['*'];

const TIMEOUT_MS = 30_000;
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`${label}: timed out after ${ms}ms`)), ms))]);

// Replace obvious PII with stable placeholders so fixtures carry shape, not secrets.
function scrub(text) {
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, 'guest@example.com')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'REDACTED_JWT')
    .replace(/"(phone|address|street|lat|lng|latitude|longitude)"\s*:\s*"[^"]*"/gi, '"$1":"REDACTED"');
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

async function liftSession() {
  const session = await withTimeout(
    bootstrap({
      serverName: pkg.name,
      version: pkg.version,
      domains: ['evite.com'],
      declare: { cookies: DECLARE_COOKIES, localStorage: [], sessionStorage: [], captureHeaders: [] },
    }),
    TIMEOUT_MS,
    'bootstrap',
  );
  return session;
}

function cookieHeader(session) {
  return Object.entries(session.cookies || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function main() {
  const mode = process.argv[2];
  if (!mode || !['--probe', '--capture'].includes(mode)) {
    console.error('usage: node scripts/spike-capture.mjs --probe | --capture <urls.txt>');
    process.exit(2);
  }

  let session;
  try {
    session = await liftSession();
  } catch (e) {
    console.error(`BRIDGE UNAVAILABLE: ${e.message}`);
    console.error('Open a signed-in evite.com tab with the fetchproxy extension connected, then retry.');
    process.exit(1);
  }

  if (mode === '--probe') {
    console.log('BRIDGE OK. Session cookie names:', Object.keys(session.cookies || {}));
    console.log('(Fill these into DECLARE_COOKIES, then run --capture with the URLs you see in DevTools.)');
    process.exit(0);
  }

  // --capture
  const listFile = process.argv[3];
  if (!listFile || !existsSync(listFile)) {
    console.error('--capture needs a file of URLs (one per line)');
    process.exit(2);
  }
  mkdirSync(FIXTURES, { recursive: true });
  const cookie = cookieHeader(session);
  const urls = readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

  for (const url of urls) {
    try {
      const res = await withTimeout(
        fetch(url, { headers: { cookie, accept: 'application/json' } }),
        TIMEOUT_MS,
        `fetch ${url}`,
      );
      const body = await res.text();
      const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
      const fixture = { url, status: res.status, contentType: res.headers.get('content-type'), body: scrub(body) };
      writeFileSync(join(FIXTURES, `${slug}.json`), JSON.stringify(fixture, null, 2));
      console.log(`captured ${res.status} ${url} -> tests/fixtures/${slug}.json`);
    } catch (e) {
      console.error(`FAILED ${url}: ${e.message}`);
    }
  }
  console.log('Done. Review fixtures for leftover PII before committing, then write docs/EVITE-API.md.');
  process.exit(0);
}

main();
