# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## TL;DR

MCP server for **Evite** event management — talks to evite.com's internal `/services/` (and `/ajax/`, `/tsunami/`) API using the session cookies a signed-in browser holds (Evite has no public API). Cookie-session archetype.

**6 read tools + 13 confirm-gated write tools** (plus `evite_healthcheck`). Writes default to a dry-run preview and only mutate on `confirm: true`.

Three auth tiers, in priority order:

1. `EVITE_EMAIL` + `EVITE_PASSWORD` — headless form login (POST `/ajax_login`). **Preferred / documented default.**
2. `EVITE_SESSION_COOKIE` — a raw `cookie:` header pasted from a signed-in evite.com tab (or set in CI). Used verbatim.
3. **fetchproxy bootstrap** — lifts the session out of the user's already-signed-in evite.com browser tab via a one-shot WebSocket bridge.

## Auth resolution

`src/auth.ts` — `resolveSession()`: the three-path priority resolver (Pattern A, "browser-bootstrap + Node-direct"). It produces a `ResolvedSession = { cookieHeader, csrfToken? }`:

1. **Tier-1 (preferred):** if **both** `EVITE_EMAIL` and `EVITE_PASSWORD` are set → `loginWithPassword()` (`src/auth-login.ts`). One env var alone falls through.
2. **Tier-2:** `EVITE_SESSION_COOKIE` → returned verbatim as `cookieHeader` (no CSRF token surfaced).
3. **Tier-3 (fallback):** `@fetchproxy/bootstrap` opens a bridge to the signed-in tab, reads the **declared** cookies (`x-evite-session`, `evtsession`, `x-evite-features`, `csrftoken` — the declared key list is the security boundary), builds the cookie header in declaration order, and surfaces `csrftoken` as the CSRF token. Opt out with `EVITE_DISABLE_FETCHPROXY=1`.
4. Nothing resolves → `SessionNotAuthenticatedError` with a hint naming the env-var escape hatches.

`src/auth-login.ts` — `loginWithPassword()`: tier-1 form login. Evite's `/ajax_login` is **Django CSRF-protected**, so a real login is two requests: (1) a priming `GET https://www.evite.com/` to obtain the `csrftoken` (+ anonymous) cookies, then (2) `POST /ajax_login` JSON `{ email, password }` carrying the full priming jar back, the `X-CSRFToken` header, and an `Origin`/`Referer`. The login response's `Set-Cookie` (read via `getSetCookie()`, with a joined-header fallback) yields the authenticated jar. The password is **never** echoed in errors. `fetchImpl` is injectable for tests.

**Session lifecycle** is delegated to `@chrischall/mcp-utils/session`'s **`CookieSessionManager`** (`src/client.ts`): single-flight login, clear-on-settle, and exactly-one re-login-and-replay on a genuine 401/403 expiry. The resolver is the manager's `login`; `isExpired` flags 401/403 — *except* a response already CSRF-recovered locally (see Quirks).

Env vars (also mirrored in `src/config.ts`): `EVITE_EMAIL`, `EVITE_PASSWORD`, `EVITE_SESSION_COOKIE`, `EVITE_DISABLE_FETCHPROXY`.

## Architecture

```
src/
  index.ts          Entry point. Constructs EviteClient, calls runMcp() with the
                    five registerXxxTools wirings (healthcheck, events, guests,
                    messages, writes). Session resolves lazily on first call.
  auth.ts           resolveSession() — three-path priority resolver (see above).
  auth-login.ts     loginWithPassword() — tier-1 form login w/ CSRF priming.
  config.ts         readEnvVar/parseBoolEnv wrappers for the four env vars.
  client.ts         EviteClient — authenticated HTTP over /services/ (+ /ajax/,
                    /tsunami/). get()/getHtml() reads, write() mutations w/ the
                    two-tier CSRF recovery, plus uploadPhoto's 4-step GCS flow.
  image-meta.ts     mimetypeForPath() + imageDimensions() for upload_photo.
  tools/
    healthcheck.ts  registerHealthcheckTools — evite_healthcheck.
    events.ts       registerEventTools — list_events, get_event, list_templates.
    guests.ts       registerGuestTools — list_guests, rsvp_summary.
    messages.ts     registerMessageTools — list_messages.
    writes.ts       registerWriteTools — the 13 confirm-gated write tools.
```

Wiring: `index.ts` passes the `registerXxxTools` functions to `runMcp({ tools: [...] })`; each registers its tools against the shared `EviteClient`.

## Tool surface

Read tools (`accept: application/json`, no mutation):

| Tool | File | Endpoint |
| --- | --- | --- |
| `evite_list_events` | events.ts | `GET /services/events/v1/` |
| `evite_get_event` | events.ts | `GET /services/event/v1/{id}` |
| `evite_list_templates` | events.ts | scrapes `GET /invites/{category}/` SSR HTML |
| `evite_list_guests` | guests.ts | `GET /services/event/v1/{id}/guests/` |
| `evite_rsvp_summary` | guests.ts | `summary` slice of the guests endpoint |
| `evite_list_messages` | messages.ts | `GET /services/event/v1/{id}/posts/` |

Write tools (all in `writes.ts`, all confirm-gated — dry-run preview unless `confirm: true`):

| Tool | Endpoint |
| --- | --- |
| `evite_rsvp` | `PUT /services/event/v1/{id}/guests/{guestId}` |
| `evite_send_message` | `POST /tsunami/v1/services/event/{id}/guest/{gid}/messages` |
| `evite_broadcast` | `POST /tsunami/v1/services/event/{id}/broadcast/` |
| `evite_upload_photo` | `POST /services/photos/v1/{id}/upload/request/` → GCS → `…/shared-gallery/` |
| `evite_create_event` | `POST /services/event/v1/` (body `{event:{…}}`) |
| `evite_update_event` | `PATCH /services/event/v1/{id}` (body `{event:{…}}`) |
| `evite_add_guest` | `POST /ajax/event/{id}/guestlist/draft/` (top-level JSON array) |
| `evite_update_guest` | `PATCH /ajax/event/{id}/guestlist/draft/` |
| `evite_remove_guest` | `DELETE /ajax/event/{id}/guestlist/draft/{guestId}` |
| `evite_send` | `POST /services/event/v1/{id}/send/` |
| `evite_cancel_event` | `POST /services/event/v1/{id}/actions/cancel/` |
| `evite_reinstate_event` | `POST /services/event/v1/{id}/actions/reinstate/` |
| `evite_duplicate_event` | `GET /plus/create/{id}/copy/` → 302 to new draft editor |

All endpoints are live-verified (probe 2026-06-01/02) — see `docs/EVITE-API.md`.

## Conventions

- **TDD.** Write the failing test first; tests mock the session resolver / `@fetchproxy/bootstrap` at the module boundary and never hit the network. `EviteClient` and `loginWithPassword` accept injectable deps for this.
- **Confirm-gating.** Every write tool takes `confirm` (`schemaConfirm`). With `confirm` absent/false the tool makes **no network call** and returns a dry-run `preview(...)` of the exact values that *would* be sent (plus any caveat). Only `confirm: true` reaches `client.write(...)`. `write()` is the *only* thing that mutates Evite.
- **stderr-only stdio.** Never `console.log` to stdout — it corrupts the MCP stdio framing. `runMcp` owns the transport; tool output goes through `textResult()`.
- **100% coverage.** `vitest.config.ts` enforces **100% lines/functions/branches/statements** on `src/**` (excluding `src/index.ts`). `npm run test:coverage` fails CI on any gap. Use `/* v8 ignore */` only for genuinely unreachable defensive branches.
- All tools are `evite_*`-prefixed; results go through `textResult()`.

## Quirks (the real ones, from `client.ts`)

- **The CSRF token ROTATES per-request.** The `csrftoken` cookie changes mid-session; a request with a stale value 403s, and Evite re-sets the fresh token on that same 403 response. The header **name** (`X-CSRFToken`) is stable; only the **value** rotates. So the token must be read **fresh** off the response (`freshCsrfFromResponse`) — **never cached**. (This is the wave-4 fix; an earlier version cached it and broke.)
- **Two-tier write recovery, capped at ONE step** (never both, never a loop). On a 401/403, `write()` spends a single recovery budget (`recovered`):
  - **(a) Rotated-CSRF (evite-local):** if the 403 carried a *new* `csrftoken`, replay with it via `withFreshCsrf()` (updating the live session in place), and **tag** the replayed response (`CSRF_RECOVERED` symbol) so the manager does **not** also re-login.
  - **(b) Genuine expiry (delegated):** a 401/403 with no fresh token is left untagged; `CookieSessionManager.isExpired` sees it, re-logs-in once, and replays exactly once.
- **Multi-API-base write surface (three bases):** REST `/services/…` (most writes), legacy `/ajax/event/{id}/…` (the draft guest list), and `/tsunami/…` (messaging — `send_message`, `broadcast`). `duplicate_event` hits `/plus/create/…`.
- **`X-CSRFToken`** is the (single, centralized) header carrying the token on writes; set in `write()` only when the session resolved a token.
- **Assumed-not-captured bodies (issue #3):** `evite_send_message` and `evite_send` endpoints are verified but their exact request **bodies** are still assumed (the observer captured the URL, not the body). `broadcast`'s body, by contrast, *was* fully captured.
- **`create_event` returns 500 on success:** the draft IS created but a secondary post-create step 500s, so `write()` throws despite success. Re-list drafts rather than retrying blindly.
- **Templates are scraped, not API:** the gallery is server-rendered; `listTemplates` regex-scrapes `/invitation/{slug}/…` links out of the category page HTML.
- **Draft guests only persist on a finalized event** (status `sending`); on a bare new `draft` the add-guest POST 200s but drops the guest.

## Versioning

**Mechanism: release-please** (`.github/workflows/release-please.yml`, config in `release-please-config.json` + manifest in `.release-please-manifest.json`). On push to `main` it scans Conventional-Commit messages and opens/updates a release PR that bumps every registered version file and `CHANGELOG.md`. Merging that PR creates the `v<VERSION>` tag + GitHub Release and runs the `publish` job (npm + MCP Registry + ClawHub + `.skill`/`.mcpb` artifacts). Uses `RELEASE_PAT` so the release PR triggers downstream workflows.

**Don't bump versions manually** — release-please owns them. The synced version files (`extra-files`):

- `package.json` (`version`) — the source of truth.
- `src/index.ts` and `src/auth.ts` — the `// x-release-please-version` annotations (`runMcp` version + `SERVER_VERSION`). `tests/version-sync.test.ts` asserts these match `package.json`.
- `manifest.json`, `server.json` (`$.version` + `$.packages[*].version`).
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (`$.plugins[*].version` + `$.metadata.version`).

## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Apply exactly one label so the change lands in the right CHANGELOG section (`feat:` → Features, `fix:` → Bug Fixes, `docs:` → Documentation, etc.). The PR title becomes the changelog bullet — write it user-facing.

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation handles it: `pr-auto-review.yml` runs a Claude review (skipping the release-please PR) and, on a `pass` verdict, adds `ready-to-merge`; `auto-merge.yml` then arms `gh pr merge --auto --squash`. So `gh pr create --label <label>` is the whole job. If the verdict is `warn`/`fail`, surface the findings and **ask** before adding `ready-to-merge` to override. Squash-merge only.

## What to *not* do

- **Don't cache the CSRF token.** It rotates per-request — read it fresh off each response (see Quirks).
- **Don't add a second recovery tier or loop in `write()`.** Recovery is capped at exactly one step (CSRF-retry XOR re-login). Don't let both fire.
- **Don't bypass confirm-gating.** A write must never reach `client.write(...)` without `confirm: true`. New write tools follow the `preview(...)` pattern.
- **Don't `console.log` to stdout** — it breaks MCP stdio framing.
- **Don't paste real cookies/credentials into tests.** Mock the resolver / `@fetchproxy/bootstrap` at the module boundary.
- **Don't bump version files by hand** — release-please owns them.
- **Don't break the "no env vars set" startup path.** The server must list tools cleanly with no session configured; auth errors are deferred to call time.
