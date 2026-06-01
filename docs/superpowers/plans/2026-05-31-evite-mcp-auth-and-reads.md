# evite-mcp — Plan 2: Auth (fetchproxy + cookie env) + Read Tools

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A working read-only evite-mcp: an `EviteClient` that authenticates by lifting the session from a signed-in tab (fetchproxy bootstrap) or a raw-cookie env var, and the 5 read tools (`evite_list_events`, `evite_get_event`, `evite_list_guests`, `evite_rsvp_summary`, `evite_list_messages`), TDD'd against captured fixtures.

**Architecture:** Mirror `signupgenius-mcp`. `src/auth.ts` resolves a session (env cookie → fetchproxy bootstrap), `src/client.ts` makes authenticated `fetch` calls to Evite's internal `/services/` API with the lifted cookies, tools in `src/tools/*.ts` register via `server.registerTool` + `textResult`. `@fetchproxy/bootstrap` is mocked at the module boundary in tests; tool handlers test against `tests/fixtures/*`.

**Tech Stack:** TS ESM/NodeNext, `@chrischall/mcp-utils`, `@fetchproxy/bootstrap`, vitest. API reference: `docs/EVITE-API.md`.

**Deferred to issues (do NOT build here):** tier-1 email/password form login (#2 — login POST flow not yet captured), tier-3 bot-wall transport, all writes (#3).

---

## API facts (from `docs/EVITE-API.md`, confirmed)

- Auth cookies: `x-evite-session`, `evtsession` (+ `x-evite-features`, `csrftoken`).
- `GET /services/events/v1/?filterBy={all|host|others}&status={upcoming|draft|archived|past|canceled}(repeatable)&type=invitation&offset=&numResults=&filter=` → `{ events: Event[], totals }`
- `GET /services/event/v1/{id}` → `{ event, settings, location, … }`
- `GET /services/event/v1/{id}/guests/` → `{ guests: Guest[], summary }`
- `GET /services/event/v1/{id}/posts/` → `{ posts: Post[] }`
- Path rule: `events` (plural) = list; `event` (singular) = per-event sub-resources.

---

## Task 1: Fixtures for event-detail + posts

**Files:** Create `tests/fixtures/event-detail.json`, `tests/fixtures/event-posts.json`

- [ ] **Step 1:** Create `tests/fixtures/event-detail.json` from the shape in `docs/EVITE-API.md` §2 (synthetic values, no PII). Include `event` (id, title, message, startDatetime, endDatetime, knownTimezoneName, eventHostName, hostId, status, isPast, category, shareableLink) and `settings` (enableMaybe, privateGuestList, plusOne, rsvpBy, rsvpOff, maxEventCapacity) and `location` (location_name, street_address, city, state, zip_code).
- [ ] **Step 2:** Create `tests/fixtures/event-posts.json` = `{ "posts": [ { "id":"POST0", "authorName":"Sample Host", "message":"See you there!", "created":"2026-05-20T12:00:00.000Z" } ] }` (best-effort post shape; refine when the writes spike captures posts precisely).
- [ ] **Step 3:** Commit: `git add tests/fixtures && git commit -m "test: event-detail + posts fixtures"`

---

## Task 2: Session resolution — `src/auth.ts`

**Files:** Create `src/auth.ts`, `tests/auth.test.ts`

- [ ] **Step 1 (test first):** `tests/auth.test.ts` — mock `@fetchproxy/bootstrap`'s `bootstrap` to resolve `{ cookies: { 'x-evite-session':'s', evtsession:'e' } }`. Assert `resolveSession()`:
  - returns a `{ cookieHeader }` built from `EVITE_SESSION_COOKIE` when that env var is set (no bootstrap call);
  - otherwise calls `bootstrap({ domains:['evite.com'], declare:{ cookies:['x-evite-session','evtsession','x-evite-features','csrftoken'], localStorage:[], sessionStorage:[], captureHeaders:[] } })` and builds the cookie header from the returned cookies;
  - throws `SessionNotAuthenticatedError` (from mcp-utils errors) with a helpful hint when neither yields a session;
  - respects `EVITE_DISABLE_FETCHPROXY=1` (skip bootstrap, require env cookie).
  Study `~/git/signupgenius-mcp/src/auth.ts` for the exact bootstrap call shape; adapt names to what `@fetchproxy/bootstrap` actually exports (read its types).
- [ ] **Step 2:** Run the test, watch it fail.
- [ ] **Step 3:** Implement `src/auth.ts` exporting `resolveSession(opts?): Promise<{ cookieHeader: string, csrfToken?: string }>` per the test. Use `readEnvVar`/`parseBoolEnv` from mcp-utils for env reads.
- [ ] **Step 4:** Run tests to green.
- [ ] **Step 5:** Commit: `git commit -am "feat: evite session resolution (cookie env + fetchproxy bootstrap)"`

---

## Task 3: HTTP client — `src/client.ts`

**Files:** Modify `src/client.ts`, Create `tests/client.test.ts`

- [ ] **Step 1 (test first):** `tests/client.test.ts` — construct `EviteClient` with an injected fake session (`{ cookieHeader: 'x-evite-session=s' }`) and a stubbed `fetch` (vi.stubGlobal) returning the `events-list.json` fixture body. Assert `client.listEvents({ filterBy:'all', status:['past'] })` issues `GET https://www.evite.com/services/events/v1/?...` with `cookie` header set, and returns the parsed `{ events, totals }`. Add a 401 case → throws `SessionNotAuthenticatedError`; a non-2xx case → error message is run through `truncateErrorMessage` (no raw body/token leakage).
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement `EviteClient`:
  - constructor takes an optional session resolver (defaults to `resolveSession`); lazily resolves on first call (deferred-config-error: construct without creds, throw at call time).
  - `private async get(path, query?)` — builds the URL (`buildQueryString` from mcp-utils for repeatable `status`), attaches `cookie` header, handles 401 → `SessionNotAuthenticatedError`, non-2xx → `formatApiError`/`truncateErrorMessage`, 200 → `r.json()`.
  - methods: `listEvents({filterBy,status,type='invitation',offset,numResults,filter})`, `getEvent(id)`, `listGuests(id)` (returns `{guests,summary}`), `rsvpSummary(id)` (returns `.summary` of listGuests), `listMessages(id)` (`/event/v1/{id}/posts/`).
  - keep `health()` but update `authMode` to reflect resolved/unresolved.
  - Note: `buildQueryString` must emit repeated `status=` params for arrays — verify against mcp-utils; if it doesn't, build the `status` params manually and use buildQueryString for the rest.
- [ ] **Step 4:** Green.
- [ ] **Step 5:** Commit: `git commit -am "feat: EviteClient over the internal /services API"`

---

## Task 4: Read tools — `src/tools/events.ts`, `guests.ts`, `messages.ts`

**Files:** Create `src/tools/events.ts`, `src/tools/guests.ts`, `src/tools/messages.ts`, and `tests/tools.test.ts`. Modify `src/index.ts`.

- [ ] **Step 1 (test first):** `tests/tools.test.ts` — using `createTestHarness` + a fake `EviteClient` (returns fixture data), register all tools and assert each returns the expected `textResult`:
  - `evite_list_events` (inputs: `filterBy` enum all|host|others default all, `status` array default [upcoming,past], `offset`, `numResults`, `filter`) → events+totals.
  - `evite_get_event` (input: `event_id`) → detail.
  - `evite_list_guests` (input: `event_id`) → guests.
  - `evite_rsvp_summary` (input: `event_id`) → summary.
  - `evite_list_messages` (input: `event_id`) → posts.
  All `annotations: { readOnlyHint: true }`. Use zod schemas (`toolAnnotations`/atoms from mcp-utils/zod where they fit).
- [ ] **Step 2:** Run, fail.
- [ ] **Step 3:** Implement the three tool files, each exporting `registerXxxTools(server, client)` using `server.registerTool(name, {description, annotations, inputSchema}, handler)` + `textResult`. `events.ts` = list+get; `guests.ts` = guests+rsvp_summary; `messages.ts` = messages.
- [ ] **Step 4:** Wire them into `src/index.ts` `tools: [...]`. Keep `registerHealthcheckTools`.
- [ ] **Step 5:** `npm run build && npm test` — all green (existing + new). Commit: `git commit -am "feat: evite read tools (events, guests, rsvp summary, messages)"`

---

## Definition of done

- `npm run build && npm test` green; all 5 read tools + healthcheck registered.
- Auth resolves via `EVITE_SESSION_COOKIE` or fetchproxy bootstrap; tests mock the bridge; no live network in tests.
- No secrets/tokens in error output (truncate/redact verified).
- README updated to note read tools are live; tier-1 login + writes remain on #2/#3.

## Self-review
- Spec coverage: auth tiers 2 (+cookie env) → Task 2; reads (all 5) → Tasks 3–4; mutation safety/writes correctly deferred. Tier-1/tier-3 deferred with rationale (login flow not captured) — tracked on #2.
- Placeholder scan: endpoints/shapes are concrete from `docs/EVITE-API.md`; the only synthetic content is the `posts` fixture (flagged "refine when writes spike runs").
- Type consistency: `resolveSession()→{cookieHeader,csrfToken?}` consumed by `EviteClient`; `listGuests` returns `{guests,summary}` and `rsvpSummary` reuses it.
