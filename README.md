# evite-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Evite](https://www.evite.com) — read and act on your events as both **guest** (invitations received) and **host** (events you created): list events, view guest lists & RSVP tallies, RSVP, message guests, and create/edit events. Built on [`@chrischall/mcp-utils`](https://github.com/chrischall/mcp-utils).

> **Status: read tools live; write tools are confirm-gated scaffolding.** The five read tools work against Evite's internal API, authenticating from a raw cookie env var or a signed-in browser tab (fetchproxy bootstrap). The four write tools are **confirm-gated; live payloads pending verification** — without `confirm: true` they only return a dry-run preview and send nothing. The exact write request bodies are not yet captured, so the live path is provisional ([#3](https://github.com/chrischall/evite-mcp/issues/3)). Tier-1 email/password login is also pending ([#2](https://github.com/chrischall/evite-mcp/issues/2)).

## Tools

Five read tools (all read-only), four confirm-gated write tools, plus `evite_healthcheck`:

| Tool | Endpoint | Returns |
| --- | --- | --- |
| `evite_list_events` | `GET /services/events/v1/` | your events + a totals breakdown (`filterBy` = all/host/others, repeatable `status`) |
| `evite_get_event` | `GET /services/event/v1/{id}` | single-event detail (event, settings, location) |
| `evite_list_guests` | `GET /services/event/v1/{id}/guests/` | the guest list + RSVP responses |
| `evite_rsvp_summary` | (derived from guests) | just the RSVP summary (yes/no/maybe/noReply + head counts) |
| `evite_list_messages` | `GET /services/event/v1/{id}/posts/` | the event's Messages thread |

### Write tools (confirm-gated; live payloads pending verification [#3](https://github.com/chrischall/evite-mcp/issues/3))

Every write tool takes `confirm: boolean`. **Without `confirm: true` it performs no network call and returns a dry-run preview** of exactly what would be sent — that is the safe default. Only `confirm: true` reaches the live path. The request bodies and the CSRF header name are **UNVERIFIED** (no live compose-capture exists yet); they are centralized so they can be corrected from one place once captured.

| Tool | Endpoint (POST/PUT) | Action |
| --- | --- | --- |
| `evite_rsvp` | `/services/event/v1/{id}/guests/{guestId}` | RSVP for a guest (response + adult/kid head counts + optional note) |
| `evite_send_message` | `/services/event/v1/{id}/posts/` | post a message to the event Messages thread |
| `evite_create_event` | `/services/event/v1/` | create an event (best-effort — the real flow is a multi-step wizard) |
| `evite_update_event` | `/services/event/v1/{id}` | edit an event (only the fields you pass change) |

## Architecture

Fetchproxy-archetype MCP. Evite has no public API, so the server calls Evite's *internal* `/services/` web API using your session. `src/auth.ts` resolves that session in priority order:

1. **`EVITE_SESSION_COOKIE`** — a raw `cookie:` header copied from a signed-in `evite.com` tab (or set in CI). Used verbatim. *(Live.)*
2. **Fetchproxy bootstrap** (fallback) — lift the session cookies (`x-evite-session`, `evtsession`, `x-evite-features`, `csrftoken`) from a signed-in `evite.com` browser tab via `@fetchproxy/bootstrap`. Bootstrap runs once; every API call then goes out via plain Node `fetch()` with the cookies attached. Opt out with `EVITE_DISABLE_FETCHPROXY=1`. *(Live.)*

Two tiers are intentionally **deferred** (the resolver is shaped to slot them in):

- **Email/password form login** — not yet captured; tracked on [#2](https://github.com/chrischall/evite-mcp/issues/2).
- **Fetchproxy as transport** (bot-wall retry through the browser bridge) — a fallback only needed if plain `fetch` trips a wall; not observed during discovery.

Writes (`evite_rsvp`, `evite_send_message`, `evite_create_event`, `evite_update_event`) ship as **confirm-gated scaffolding** (dry-run preview unless `confirm: true`). The single private `client.write()` helper attaches the CSRF token (the `csrftoken` cookie) via one centralized header (`CSRF_HEADER`, default `x-csrf-token`). The exact header name and the request payloads are **UNVERIFIED** pending a live compose-capture — tracked on [#3](https://github.com/chrischall/evite-mcp/issues/3).

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

**Open work:** [#2 tier-1 email/password login](https://github.com/chrischall/evite-mcp/issues/2) remains, and [#3](https://github.com/chrischall/evite-mcp/issues/3) tracks verifying the write payloads + CSRF header against a live compose-capture (the write tools exist as confirm-gated scaffolding meanwhile). [#4](https://github.com/chrischall/evite-mcp/issues/4) tracks publishing the shared lib. (Discovery [#1](https://github.com/chrischall/evite-mcp/issues/1) and the read tools are done.)

## License

MIT
