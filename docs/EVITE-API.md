# Evite Internal API — Discovery Notes

> **STATUS: partially verified from a live session (2026-05-31).** Captured by
> driving a signed-in evite.com tab (Claude-in-Chrome) and reading the network +
> in-page `fetch`. The **events-list read** and the **auth model** are confirmed
> against real responses; the **guest-list / messages / write** endpoint paths
> are not yet pinned (see "Still to capture"). Evite has no public API — all of
> this is the site's own internal `/services/` layer.

## Confirmed

### Transport / infra
- REST API under `https://www.evite.com/services/…/v{N}/`. JSON responses.
- **Cloudflare in front** (`/cdn-cgi/rum`) — relevant to the tier-3 bot-wall
  transport escalation. (No bot-wall hit on plain `fetch` with session cookies
  during the spike.)
- Frontend is a MobX SPA served from `g0.evitecdn.com`; most pages are
  **server-rendered**, so navigating doesn't always fire an XHR — client-side
  filter toggles do.

### Auth (drives Plan 2 tiers 1–2)
- Session is carried by cookies **`x-evite-session`** and **`evtsession`**
  (plus `x-evite-features` for flags). These are the cookies the fetchproxy
  bootstrap must declare, and what a headless form-login must capture.
- **CSRF** for writes: cookie **`csrftoken`**; the SPA also exposes the token as
  `window[window.DATASET_KEY]` where `DATASET_KEY === "fetchproxyCsrf"` (Evite's
  own internal name — unrelated to our `@fetchproxy`). Write requests will need
  the `csrftoken` value as a header/body field (exact header TBD with a write
  capture).
- `client_data` (a page global) carries `session_id`, `email`, and hashed
  `evc_*` values — context, not the raw session.

### Events list — `GET /services/events/v1/` (fully captured)
Query params:
- `filterBy` = `all` | `host` | `others` (**`others` = events where you're a guest**)
- `status` = repeatable: `upcoming` | `draft` | `archived` | `past` | `canceled`
- `type` = `invitation`
- `offset`, `numResults` = pagination; `filter` = free-text search

Response: `{ events: Event[], totals: {...} }`.
- `totals` = `{ all, sending, draft, received, canceled, past, upcoming, archived }`
  (counts; `sending` = events you host, `received` = events you're invited to).
- `Event` fields (see `tests/fixtures/events-list.json` for the full scrubbed shape):
  `event_id`, `title`, `start`, `end`, `status`, `past`, `is_host`,
  `rsvp` (string: `yes`|`no`|`maybe`), `guest_status` (number 0/1/2),
  `guest_id`, `host_id`, `host_name`, `location` (object: `location_name`,
  `street_address`, `unit_num`, `city`, `state`, `zip_code`, `place_id`),
  `timezone`, `known_timezone_name`, `template_name`, `event_category`,
  `rsvp_off`, `is_invite`, `is_pending_cohost`, `rendered_image_url`, `updated`.

### Page routes (for context / cross-checking)
- Events dashboard (the `my-events` list): `GET /my-events?filterBy=…&status=…&type=invitation`
- Guest-facing event page: `/event/{event_id}` (tabs: **Event**, **Messages**)
- Host management dashboard: `/event/{event_id}/dashboard` — surfaces
  **Send message**, **Export guest list**, **Duplicate event**, **View event**.

## Still to capture (next spike pass — see issue #1)

The guest-list, messages, and all write endpoints render server-side or fire
from the bundle, so their exact `/services/` paths weren't observed (guessed
paths fall through to the SPA HTML, not JSON). To finish:
1. On `/event/{id}/dashboard`, open the **guest list / RSVP tracker** section and
   read the XHR that loads guests → the guest-list endpoint + guest object shape.
2. Click into **Messages** and **Send message** (compose, do NOT send) → the
   messages list + send endpoints, and confirm the CSRF header name on the POST.
3. RSVP: on a guest event, open the RSVP control → capture the RSVP POST
   (status values, guest count, note fields, CSRF).
4. Create/edit: walk the create wizard one step (don't submit) → capture the
   POST shape (likely multi-step).

Record each as a scrubbed fixture and fill the tables here.

## Resolved Open Questions (from the spec)
- **REST vs GraphQL:** REST (`/services/{resource}/v{N}/`).
- **Session cookie names:** `x-evite-session`, `evtsession`.
- **CSRF:** yes — `csrftoken` cookie (+ `window.fetchproxyCsrf`).
- **Bot-wall vendor:** Cloudflare (not tripped by plain `fetch` in the spike).
- **Pagination:** `offset` + `numResults`, with a `totals` breakdown object.

## Still open (need the captures above)
- Guest-list / messages / RSVP / event-create endpoint paths + payloads.
- Whether event-create is single-call or multi-step.
- Whether a multi-account session registry is warranted (single session observed).
