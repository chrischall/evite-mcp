# evite-mcp — Plan 1: Scaffold + Discovery Spike

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a booting `evite-mcp` scaffold (green tests, one healthcheck tool) on `@chrischall/mcp-utils`, then run a fetchproxy discovery spike that maps Evite's internal web API into `docs/EVITE-API.md` + recorded fixtures.

**Architecture:** Clone the `signupgenius-mcp` fleet skeleton (closest sibling). Wire `@chrischall/mcp-utils` (core + `/fetchproxy` + `/test`) and pin `@fetchproxy/server ^0.11`. The scaffold proves the toolchain + bootstrap before any Evite-specific logic. The spike uses `@fetchproxy/bootstrap` against the user's signed-in tab to capture real requests/responses, recorded (PII-scrubbed) as fixtures that drive TDD in later plans.

**Tech Stack:** TypeScript (ESM/NodeNext), `@modelcontextprotocol/sdk` ^1.29, `zod` ^4.4, `@chrischall/mcp-utils` (local tarball), `@fetchproxy/server`/`@fetchproxy/bootstrap` ^0.11, vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-evite-mcp-design.md`

---

## File Structure

- `package.json` — name `evite-mcp`, deps, scripts (build = `tsc && esbuild` bundle; test = `vitest run`).
- `tsconfig.json` — NodeNext, strict, `"types": ["node"]` (fleet gotcha for scoped-pkg imports).
- `vitest.config.ts`, `.gitignore` (already present), `.env.example`.
- `src/index.ts` — bootstrap via `runMcp`.
- `src/client.ts` — `EviteClient` skeleton (deferred-config-error; healthcheck only for now).
- `src/config.ts` — env reads via `mcp-utils/config`.
- `src/tools/healthcheck.ts` — `evite_healthcheck` (proves the wiring end-to-end).
- `tests/healthcheck.test.ts`, `tests/version-sync.test.ts`.
- `scripts/spike-capture.ts` — the discovery spike harness (dev-only, not shipped).
- `docs/EVITE-API.md` — output of the spike (endpoint map).
- `tests/fixtures/` — recorded, scrubbed responses.

---

## Task 1: Scaffold from the signupgenius skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `src/index.ts`, `src/client.ts`, `src/config.ts`

- [ ] **Step 1: Copy the non-source skeleton from signupgenius-mcp**

```bash
cd /Users/chris/git/evite-mcp
cp ../signupgenius-mcp/tsconfig.json ../signupgenius-mcp/vitest.config.ts .
# package.json copied then rewritten in next step; do NOT copy src/ or tests/ (Evite-specific)
cp ../signupgenius-mcp/package.json package.json
```

- [ ] **Step 2: Rewrite package.json identity + deps**

Set `"name": "evite-mcp"`, `"version": "0.1.0"`, fresh `"description"`. Dependencies:

```json
{
  "dependencies": {
    "@chrischall/mcp-utils": "file:../mcp-utils/chrischall-mcp-utils-0.1.0.tgz",
    "@fetchproxy/bootstrap": "^0.11.0",
    "@fetchproxy/server": "^0.11.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.4.0"
  }
}
```

Keep signupgenius's `devDependencies` (typescript, vitest, @types/node, esbuild) and `scripts`.

- [ ] **Step 3: Ensure `"types": ["node"]` in tsconfig**

Confirm `compilerOptions.types` includes `"node"` (fleet gotcha: scoped-pkg import otherwise breaks node-global type resolution under NodeNext).

- [ ] **Step 4: Install**

Run: `npm install`
Expected: clean install, `@chrischall/mcp-utils` resolved from the local tarball, no ERESOLVE.

- [ ] **Step 5: Write `src/config.ts`**

```ts
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';

export const config = {
  email: () => readEnvVar('EVITE_EMAIL'),
  password: () => readEnvVar('EVITE_PASSWORD'),
  disableFetchproxy: () => parseBoolEnv('EVITE_DISABLE_FETCHPROXY', false),
};
```

- [ ] **Step 6: Write a minimal `src/client.ts` (healthcheck-only)**

```ts
export interface EviteHealth {
  ok: boolean;
  authMode: 'none';
  note: string;
}

export class EviteClient {
  health(): EviteHealth {
    return { ok: true, authMode: 'none', note: 'scaffold — auth + tools land in later plans' };
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold evite-mcp from fleet skeleton"
```

---

## Task 2: Healthcheck tool + bootstrap (first green slice)

**Files:**
- Create: `src/tools/healthcheck.ts`, `tests/healthcheck.test.ts`, `src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/healthcheck.test.ts
import { describe, it, expect } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { EviteClient } from '../src/client.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

describe('evite_healthcheck', () => {
  it('reports ok with the scaffold auth mode', async () => {
    const client = new EviteClient();
    const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
    const res = await h.callTool('evite_healthcheck', {});
    const data = parseToolResult<{ ok: boolean; authMode: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.authMode).toBe('none');
    await h.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/healthcheck.test.ts`
Expected: FAIL — cannot find `../src/tools/healthcheck.js`.

- [ ] **Step 3: Implement the tool**

```ts
// src/tools/healthcheck.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import type { EviteClient } from '../client.js';

export function registerHealthcheckTools(server: McpServer, client: EviteClient): void {
  server.registerTool(
    'evite_healthcheck',
    { description: 'Report evite-mcp status and the resolved auth mode.', annotations: { readOnlyHint: true } },
    async () => textResult(client.health()),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/healthcheck.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Write `src/index.ts` bootstrap**

```ts
#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { EviteClient } from './client.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';

const client = new EviteClient();

await runMcp({
  name: 'evite-mcp',
  version: '0.1.0', // x-release-please-version
  banner: '[evite-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [registerHealthcheckTools],
});
```

- [ ] **Step 6: Build + full test**

Run: `npm run build && npm test`
Expected: build exit 0; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: evite_healthcheck tool + runMcp bootstrap"
```

---

## Task 3: Version-sync guard

**Files:**
- Create: `tests/version-sync.test.ts`

- [ ] **Step 1: Write the test using the shared helper**

```ts
// tests/version-sync.test.ts
import { versionSyncTest } from '@chrischall/mcp-utils/test';

versionSyncTest({ srcDir: 'src', pkgPath: 'package.json' });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/version-sync.test.ts`
Expected: PASS — the `x-release-please-version` marker in `src/index.ts` matches `package.json` `0.1.0`.

- [ ] **Step 3: Commit**

```bash
git add tests/version-sync.test.ts
git commit -m "test: version-sync guard"
```

---

## Task 4: Discovery spike — capture Evite's internal API

> This task is **interactive** and requires the user's signed-in `evite.com` tab + a running fetchproxy bridge. Its output (`docs/EVITE-API.md` + fixtures) is the input to Plans 2–3. Do NOT guess endpoints — record what the live site actually does.

**Files:**
- Create: `scripts/spike-capture.ts`, `docs/EVITE-API.md`, `tests/fixtures/*.json`

- [ ] **Step 1: Confirm the bridge is reachable**

Write `scripts/spike-capture.ts` that calls `@fetchproxy/bootstrap`'s `bootstrap({ domains: ['evite.com'], ... })` to open a one-shot bridge and lift the session. Run it:

Run: `npx tsx scripts/spike-capture.ts --probe`
Expected: prints the captured cookie/token names (NOT values) and confirms a signed-in session. If it errors `bridge unavailable`, stop and ask the user to open a signed-in evite.com tab with the extension connected.

- [ ] **Step 2: Capture each flow's request/response**

For each flow — list events (host + guest), event detail, guest list, RSVP, list messages, send message, create event, edit event — perform the action in the tab (or replay the XHR with the lifted session) and record the request (method, URL, query, body, auth header/cookie) + response JSON. The spike script appends each to `tests/fixtures/<flow>.json`.

**Scrub PII before saving:** replace real emails/names/addresses/tokens with stable placeholders (`guest1@example.com`, `Guest One`, `REDACTED_TOKEN`). The fixtures must contain shape, not secrets.

- [ ] **Step 3: Write `docs/EVITE-API.md`**

Document, per flow: endpoint (method + path + key query/body params), auth requirement (cookie/CSRF/Bearer), whether it's REST or GraphQL, pagination shape, and the response fields the tools will surface. Note any bot-wall behavior observed (which vendor, on which routes).

- [ ] **Step 4: Validate fixtures load**

```ts
// quick check, not committed as a permanent test
import fs from 'node:fs';
for (const f of fs.readdirSync('tests/fixtures')) JSON.parse(fs.readFileSync(`tests/fixtures/${f}`, 'utf8'));
```

Run the check; expected: all fixtures parse, none contain a real email/token (grep for `@gmail`/`@evite` etc. → none).

- [ ] **Step 5: Commit the API map + fixtures (verify no secrets)**

```bash
grep -rInE '@(gmail|yahoo|outlook|hotmail|icloud)\.com|eyJ[A-Za-z0-9_-]{20,}' tests/fixtures docs/EVITE-API.md && echo "SECRET FOUND — scrub before commit" || git add docs/EVITE-API.md tests/fixtures scripts/spike-capture.ts
git commit -m "docs: Evite internal API map + scrubbed fixtures from discovery spike"
```

---

## Definition of done (Plan 1)

- `npm run build && npm test` green; `evite_healthcheck` works; version-sync passes.
- `docs/EVITE-API.md` documents every flow in the spec's tool list.
- `tests/fixtures/*.json` recorded and verified secret-free.
- Open questions from the spec (cookie/token names, REST vs GraphQL, event-create shape, registry need, bot-wall vendor) answered in `docs/EVITE-API.md`.

**Next:** re-invoke `superpowers:writing-plans` to author **Plan 2 (auth tiers 1–3 + read tools)** and **Plan 3 (write tools)** using the discovered API.

---

## Self-Review

- **Spec coverage:** scaffold + bootstrap (spec §Overview/Foundation) → Tasks 1–2. Version markers (spec §Testing) → Task 3. Discovery spike + EVITE-API.md + fixtures + open-questions (spec §Discovery/Open questions) → Task 4. Auth tiers + the 9 tools + mutation safety are intentionally deferred to Plans 2–3 (can't be written without the spike output) — flagged at top and in Task 4's "Next".
- **Placeholder scan:** Task 4's per-flow endpoint details are produced BY the task (the spike), not assumed — this is discovery work, not a code placeholder. All code steps (Tasks 1–3) contain complete code.
- **Type consistency:** `EviteClient.health()` → `EviteHealth` used in Task 2's test; `registerHealthcheckTools(server, client)` signature consistent across Task 2 and `index.ts`.
