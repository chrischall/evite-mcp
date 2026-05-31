# evite-mcp — Design Spec

_2026-05-31. A Model Context Protocol server for Evite, on `@chrischall/mcp-utils`._

## Overview

`evite-mcp` exposes a user's Evite events to Claude over stdio — both as a **guest**
(invitations received) and a **host** (events created) — with read tools plus
confirm-gated write tools (RSVP, host messaging, event authoring).

Evite has **no public API**. The server talks to Evite's *internal* web API (the
same JSON endpoints evite.com's own frontend calls). Those endpoints are
undocumented, so the exact paths/payloads are resolved by a **discovery spike**
against a live signed-in tab before tool shapes are frozen (see §Discovery).

It is a **fetchproxy-archetype** MCP, cloned from the closest sibling,
`signupgenius-mcp` (events/RSVP domain). Standard fleet layout: ESM/NodeNext,
strict TS, vitest, release-please, the usual packaging files. Built on
`@chrischall/mcp-utils` (core + `/fetchproxy` + `/session` + `/test`).

Because this is a **new** repo, it pins `@fetchproxy/server ^0.11` from day one so
it can use `mcp-utils/fetchproxy` (which re-exports 0.11+ APIs) with no
version split-brain.

## Auth & transport — 3-tier escalation

Session **resolution** order (least friction → most robust):

1. **Email/password (default).** `EVITE_EMAIL` + `EVITE_PASSWORD` set → headless
   form login: GET the login page, scrape the CSRF token, POST credentials,
   capture the session cookies/token. Requests then go via plain Node `fetch`.
   No browser required.
2. **Fetchproxy bootstrap (fallback).** When no creds are set, *or* tier-1 login
   fails (MFA / captcha / changed form), open a one-shot `@fetchproxy/bootstrap`
   bridge to the signed-in `evite.com` tab and lift the session cookies/token —
   **declared upfront** (the security boundary). Requests still go via plain
   `fetch`; the bridge is not in the hot path.

Request **transport**:

3. **Fetchproxy as transport (last resort — bot detection).** If a plain-`fetch`
   request trips a bot-wall (Cloudflare / DataDome / PerimeterX, detected via
   `classifyBotWall` from `mcp-utils/fetchproxy`), retry *that request through
   the browser bridge* so it carries the real browser's TLS/JA3/headers. This
   layers on top of whichever session tier 1 or 2 established — fetchproxy enters
   the hot path only when a request is actually blocked.

`EVITE_DISABLE_FETCHPROXY=1` opts out of tiers 2–3 (pure headless; fail loudly if
creds are missing/blocked). Deferred-config-error pattern: the client is built in
`index.ts`'s caller and the "no auth available" error is thrown at first tool
call, so the server still boots for the host's install-time `tools/list` probe.

Auth lives in `src/auth.ts` (resolution) + `src/auth-session-login.ts` (the
form-login flow), mirroring signupgenius's structure.

## Tools

Tool prefix `evite_`. Final input/output shapes are pinned after the discovery
spike; the set is:

**Reads** (`readOnlyHint`):
- `evite_list_events` — events you host and invitations you've received; filters
  for role (host/guest), time (upcoming/past), and RSVP status.
- `evite_get_event` — full detail for one event (title, when/where, host, your
  RSVP, counts).
- `evite_list_guests` — guest list for a hosted event with each guest's RSVP
  status, party size, and note.
- `evite_rsvp_summary` — yes/no/maybe/no-reply tallies + headcount for an event.
- `evite_list_messages` — the message/comment thread on an event.

**Writes** (confirm-gated, non-readonly):
- `evite_rsvp` — respond to an invitation (yes/no/maybe, guest count, optional
  note).
- `evite_send_message` — host → guests message / reminder on an event.
- `evite_create_event` — create a new event (title, date/time, location, guest
  list). Heaviest; Evite's create flow is multi-step.
- `evite_update_event` — edit an existing hosted event's fields.

`src/tools/*.ts` files: `events.ts` (list/get), `guests.ts` (guests + summary),
`messages.ts` (list/send), `rsvp.ts`, `authoring.ts` (create/update), plus
`sessions.ts` if a session registry is warranted (decided after the spike).
Each exports `registerXxxTools(server, client)` using `server.registerTool` +
`textResult`.

## Mutation safety

Every write tool takes `confirm: boolean` (`schemaConfirm` from `mcp-utils/zod`).
Without `confirm: true`, the tool performs **no mutation** and returns a dry-run
preview describing exactly what it would do (which event, the RSVP value, the
message body, the fields to change). Annotations mark writes non-readonly;
`evite_create_event`/`evite_update_event` are built last and gated hardest. No
destructive bulk operations in v1.

## Discovery spike (first build step)

Before freezing tool shapes, run a fetchproxy spike against the live signed-in
tab to capture, for each operation, the real request: method, path, query, body,
auth header/cookie names, and response shape. Target flows: session/auth, list
events (host + guest), event detail, guest list, RSVP, send message, create
event, edit event. Record sanitized responses (PII scrubbed) as **fixtures**
under `tests/fixtures/` to drive TDD. Output: a short `docs/EVITE-API.md` mapping
the internal endpoints the server depends on.

## Testing

- `createTestHarness` (from `mcp-utils/test`) for the in-memory client/server.
- `@fetchproxy/bootstrap` mocked at the module boundary (signupgenius pattern);
  no live network in tests.
- Tool handlers tested against recorded fixtures; auth tiers unit-tested
  (login-success, login-fail→bootstrap, bot-wall→bridge-transport) with the
  bridge + `fetch` mocked.
- `versionSyncTest` from `mcp-utils/test` guards the version markers.

## Security & privacy

- No credentials in code; `.env` gitignored (`*.p8`-style ignore set from the
  template). Session token/cookies never logged; error bodies go through
  `truncateErrorMessage` (Bearer/JWT redaction).
- Fetchproxy capability scope is the minimum set of cookies/keys discovered in
  the spike, declared upfront.
- Guest PII (emails, names) is returned to the caller by design (that's the
  product) but never written to disk or logs.

## Build sequence

1. Discovery spike → `docs/EVITE-API.md` + fixtures.
2. Scaffold repo (clone signupgenius skeleton) + auth tiers 1–2 (green).
3. Read tools (events, guests, summary, messages).
4. `evite_rsvp` (first write; establish confirm-gating).
5. `evite_send_message`.
6. `evite_create_event` / `evite_update_event` (authoring, hardest).
7. Bot-wall transport escalation (tier 3) wired + tested.

Each step is a TDD slice: failing test → implementation → green, suite stays
green throughout.

## Open questions (resolved by the spike)

- Exact session cookie/token names and whether Evite uses CSRF on writes.
- Whether the internal API is REST or GraphQL (changes client shape).
- Whether a multi-account **session registry** (`mcp-utils/session`) is worth it,
  or single-session is enough.
- Event-create payload shape (single call vs multi-step).
