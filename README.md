# evite-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Evite](https://www.evite.com) — read and act on your events as both **guest** (invitations received) and **host** (events you created): list events, view guest lists & RSVP tallies, RSVP, message guests, and create/edit events. Built on [`@chrischall/mcp-utils`](https://github.com/chrischall/mcp-utils).

> **Status: early scaffold.** A booting MCP with an `evite_healthcheck` tool and green tests is in place. The real tools depend on a discovery spike of Evite's internal API (Evite has no public API) — tracked in the issues below.

## Architecture

Fetchproxy-archetype MCP. Evite has no public API, so the server calls Evite's *internal* web API using your session, resolved by a 3-tier escalation:

1. **Email/password** (default) — headless form login, requests via plain `fetch`.
2. **Fetchproxy bootstrap** (fallback) — lift your session from a signed-in `evite.com` browser tab when no creds are set or login fails.
3. **Fetchproxy as transport** (last resort) — if a request trips a bot-wall, retry it through the browser bridge.

Writes (`evite_rsvp`, `evite_send_message`, `evite_create_event`, `evite_update_event`) are confirm-gated (dry-run preview unless `confirm: true`).

## Development

```bash
npm install      # resolves @chrischall/mcp-utils from a local tarball (see issue #4)
npm run build
npm test
```

## Docs & roadmap

- Design spec: [`docs/superpowers/specs/2026-05-31-evite-mcp-design.md`](docs/superpowers/specs/2026-05-31-evite-mcp-design.md)
- Plan 1 (scaffold + spike): [`docs/superpowers/plans/2026-05-31-evite-mcp-scaffold-and-spike.md`](docs/superpowers/plans/2026-05-31-evite-mcp-scaffold-and-spike.md)
- Internal API hypothesis: [`docs/EVITE-API.md`](docs/EVITE-API.md) (to be replaced by spike output)

**Open work:** [#1 discovery spike](https://github.com/chrischall/evite-mcp/issues/1) → [#2 auth + read tools](https://github.com/chrischall/evite-mcp/issues/2) → [#3 write tools](https://github.com/chrischall/evite-mcp/issues/3). [#4](https://github.com/chrischall/evite-mcp/issues/4) tracks publishing the shared lib.

## License

MIT
