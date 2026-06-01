# evite-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Evite](https://www.evite.com) — read and act on your events as both **guest** (invitations received) and **host** (events you created): list events, view guest lists & RSVP tallies, RSVP, message guests, and create/edit events. Built on [`@chrischall/mcp-utils`](https://github.com/chrischall/mcp-utils).

> **Status: read + write tools live.** The five read tools work against Evite's internal API, authenticating from email/password (tier-1, `POST /ajax_login`), a raw cookie env var, or a signed-in browser tab (fetchproxy bootstrap). The eight write tools are **confirm-gated** — without `confirm: true` they only return a dry-run preview and send nothing — and their endpoints are **live-verified** (see [`docs/EVITE-API.md`](docs/EVITE-API.md)); a couple of request *bodies* are still assumed rather than captured ([#3](https://github.com/chrischall/evite-mcp/issues/3)).

## Tools

Five read tools (all read-only), eight confirm-gated write tools, plus `evite_healthcheck`:

| Tool | Endpoint | Returns |
| --- | --- | --- |
| `evite_list_events` | `GET /services/events/v1/` | your events + a totals breakdown (`filterBy` = all/host/others, repeatable `status`) |
| `evite_get_event` | `GET /services/event/v1/{id}` | single-event detail (event, settings, location) |
| `evite_list_guests` | `GET /services/event/v1/{id}/guests/` | the guest list + RSVP responses |
| `evite_rsvp_summary` | (derived from guests) | just the RSVP summary (yes/no/maybe/noReply + head counts) |
| `evite_list_messages` | `GET /services/event/v1/{id}/posts/` | the event's Messages thread |

### Write tools (confirm-gated)

Every write tool takes `confirm: boolean`. **Without `confirm: true` it performs no network call and returns a dry-run preview** of exactly what would be sent — that is the safe default. Only `confirm: true` reaches the live path. Endpoints are verified; the CSRF token (`X-CSRFToken`, read fresh per request as it rotates) is attached centrally.

| Tool | Endpoint | Action |
| --- | --- | --- |
| `evite_rsvp` | `PUT /services/event/v1/{id}/guests/{guestId}` | RSVP for a guest (response + adult/kid head counts + optional note) |
| `evite_send_message` | `POST /tsunami/v1/services/event/{id}/guest/{gid}/messages` | send a private message to one guest (body assumed) |
| `evite_create_event` | `POST /services/event/v1/` (`{event:{…}}`) | create an event draft (needs `template_name`; the API 500s even on success) |
| `evite_update_event` | `PATCH /services/event/v1/{id}` (`{event:{…}}`) | edit an event (only the fields you pass change) |
| `evite_add_guest` | `POST /ajax/event/{id}/guestlist/draft/` | add guests to the draft (un-sent) list — `[{name,email}]` |
| `evite_send` | `POST /services/event/v1/{id}/send/` | **"Send now"** — emails the ready-to-send guests |
| `evite_cancel_event` | `POST …/actions/cancel/` | cancel an event / delete a draft (destructive; reversible) |
| `evite_reinstate_event` | `POST …/actions/reinstate/` | reinstate a cancelled event |

The authoring flow is `evite_create_event` → `evite_add_guest` → `evite_send`. `evite_send`, `evite_send_message`, and `evite_cancel_event` have real-world effects (emails / cancellation notices), so their confirm-gating matters.

## Architecture

Fetchproxy-archetype MCP. Evite has no public API, so the server calls Evite's *internal* `/services/` web API using your session. `src/auth.ts` resolves that session in priority order:

1. **`EVITE_EMAIL` + `EVITE_PASSWORD`** (tier-1, preferred) — headless email/password form login: POST the creds to `https://www.evite.com/ajax_login`, then build the session from the response `Set-Cookie` jar (`x-evite-session`, `evtsession`, `csrftoken`, `x-evite-features`). No browser bridge, no hand-copied cookie. Both vars must be set, or the resolver falls through. *(Live.)*
2. **`EVITE_SESSION_COOKIE`** — a raw `cookie:` header copied from a signed-in `evite.com` tab (or set in CI). Used verbatim. *(Live.)*
3. **Fetchproxy bootstrap** (fallback) — lift the session cookies (`x-evite-session`, `evtsession`, `x-evite-features`, `csrftoken`) from a signed-in `evite.com` browser tab via `@fetchproxy/bootstrap`. Bootstrap runs once; every API call then goes out via plain Node `fetch()` with the cookies attached. Opt out with `EVITE_DISABLE_FETCHPROXY=1`. *(Live.)*

One tier is intentionally **deferred** (the resolver is shaped to slot it in):

- **Fetchproxy as transport** (bot-wall retry through the browser bridge) — a fallback only needed if plain `fetch` trips a wall; not observed during discovery.

The eight write tools (rsvp, add-guest, send, send-message, create/update/cancel/reinstate event) are **confirm-gated** (dry-run preview unless `confirm: true`). The single private `client.write()` helper attaches the CSRF token via one centralized header (`CSRF_HEADER` = `X-CSRFToken`; the `csrftoken` cookie rotates mid-session, so it's read fresh per request). Endpoints span three bases — REST `/services/…`, the legacy `/ajax/event/{id}/…` guest list, and the `/tsunami/…` messaging service — all live-verified; a couple of request bodies remain assumed ([#3](https://github.com/chrischall/evite-mcp/issues/3)).

## Development

```bash
npm install      # resolves @chrischall/mcp-utils from a local tarball (see issue #4)
npm run build
npm test
```

## Docs & roadmap

- Design spec: [`docs/superpowers/specs/2026-05-31-evite-mcp-design.md`](docs/superpowers/specs/2026-05-31-evite-mcp-design.md)
- Plan 1 (scaffold + spike): [`docs/superpowers/plans/2026-05-31-evite-mcp-scaffold-and-spike.md`](docs/superpowers/plans/2026-05-31-evite-mcp-scaffold-and-spike.md)
- Plan 2 (auth + read tools): [`docs/superpowers/plans/2026-05-31-evite-mcp-auth-and-reads.md`](docs/superpowers/plans/2026-05-31-evite-mcp-auth-and-reads.md)
- Internal API reference (verified from a live session): [`docs/EVITE-API.md`](docs/EVITE-API.md)

**Open work:** [#3](https://github.com/chrischall/evite-mcp/issues/3) — write endpoints + CSRF are now live-verified; only a couple of request *bodies* (send / send-message) remain assumed. [#4](https://github.com/chrischall/evite-mcp/issues/4) tracks publishing the shared lib. (Discovery [#1](https://github.com/chrischall/evite-mcp/issues/1), tier-1 email/password login [#2](https://github.com/chrischall/evite-mcp/issues/2), and the read tools are done.)

## License

MIT
