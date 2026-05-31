# Evite Internal API — Working Hypothesis

> ⚠️ **STATUS: ASSUMPTIONS, NOT VERIFIED.** Evite has no public API. The real
> endpoints/payloads must be captured by the discovery spike
> (`scripts/spike-capture.mjs`) against a live signed-in tab — see
> [issue: run discovery spike](https://github.com/chrischall/evite-mcp/issues).
> This file is a *starting hypothesis* to orient that spike; every row below is
> to be confirmed or corrected from recorded fixtures. Do **not** implement tool
> request code against these guesses without spike confirmation.

## How to replace this file with real data

1. Open a signed-in `evite.com` tab; connect the fetchproxy extension.
2. `node scripts/spike-capture.mjs --probe` → record the real session cookie
   names; put them in `DECLARE_COOKIES`.
3. In DevTools → Network, perform each flow (view my events, open an event, view
   guest list, RSVP, send a message, create/edit an event) and copy the XHR/fetch
   URLs into a `urls.txt`.
4. `node scripts/spike-capture.mjs --capture urls.txt` → scrubbed fixtures in
   `tests/fixtures/`.
5. Rewrite the tables below from what you observed; delete this warning block.

## Assumed shape (to verify)

- **Base / auth:** assumed a cookie-session web app (login at
  `https://www.evite.com/login` or an `/auth` POST with a CSRF token), with an
  internal JSON API under an `api.evite.com` or `www.evite.com/api/...` host.
  **Unknown:** exact host, REST vs GraphQL, session cookie name(s), whether
  writes require a CSRF/XSRF header.
- **Bot protection:** unknown vendor (Cloudflare/DataDome/PerimeterX?). The
  tier-3 transport escalation exists precisely because this is unknown — confirm
  in the spike whether plain `fetch` with the lifted cookies is ever bot-walled.

| Flow | Assumed method + path (VERIFY) | Notes / unknowns |
|------|-------------------------------|------------------|
| List my events (host + guest) | `GET /api/.../events?role=host\|guest` | pagination shape unknown; may be split host vs invited endpoints |
| Event detail | `GET /api/.../events/{id}` | id format unknown (numeric vs slug/uuid) |
| Guest list | `GET /api/.../events/{id}/guests` | RSVP status enum values unknown (yes/no/maybe/pending?) |
| RSVP summary | possibly derived from guest list, or a `/summary` endpoint | may not be a separate call |
| List messages | `GET /api/.../events/{id}/messages` | comments vs host-messages may differ |
| RSVP (write) | `POST /api/.../events/{id}/rsvp` | body fields (status, guestCount, note) + CSRF unknown |
| Send message (write) | `POST /api/.../events/{id}/messages` | host-only? recipient targeting unknown |
| Create event (write) | likely multi-step `POST /api/.../events` | Evite create is a wizard; may be several calls |
| Update event (write) | `PATCH/PUT /api/.../events/{id}` | partial vs full payload unknown |

## Decisions blocked on the spike (from the spec's Open Questions)

- Exact session cookie/token names + whether writes need CSRF.
- REST vs GraphQL (changes `EviteClient` shape significantly).
- Event-create payload (single call vs multi-step wizard).
- Whether a multi-account session registry (`mcp-utils/session`) is warranted.
- Bot-wall vendor + which routes trip it (drives the tier-3 transport).
