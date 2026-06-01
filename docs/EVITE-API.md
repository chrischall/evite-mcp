# Evite Internal API — Discovery Notes

> **STATUS: read API + auth fully verified from a live session (2026-05-31).**
> Captured by driving a signed-in evite.com tab (Claude-in-Chrome) + in-page
> `fetch`. All five read endpoints and the auth model are confirmed against real
> responses. The write endpoints' resource locations are known; their exact
> request payloads need a compose-capture (see "Writes"). Evite has no public
> API — this is the site's own internal `/services/` layer.

## Path conventions (important)
- **List** of your events: **`/services/events/v1/`** (plural `events`).
- **Single-event** sub-resources: **`/services/event/v1/{id}/…`** (singular `event`).
  (Guessing the plural form for sub-resources returns the SPA HTML, not JSON.)
- REST, JSON. Trailing slash tolerated.

## Auth (Plan 2 tiers 1–2)
- Session cookies: **`x-evite-session`** + **`evtsession`** (+ `x-evite-features`).
  These are what the fetchproxy bootstrap declares / a headless form-login captures.
- **CSRF** (writes): cookie **`csrftoken`** (also exposed as `window.fetchproxyCsrf`
  — Evite's internal name, unrelated to our `@fetchproxy`).

### Tier-1 email/password login — CAPTURED (2026-06-01)
- **`POST https://www.evite.com/ajax_login`**, JSON body `{ "email", "password" }`
  (no CSRF token required on the login request itself).
- On 200 the response **sets the session cookies** (`x-evite-session`,
  `evtsession`, `csrftoken`, `x-evite-features`) via `Set-Cookie`, and returns a
  JSON body: `{ full_name, first_name, initials, user_id, email, image_url,
  avatar_disk, subscription_plan_name, token }`. The `token` + the cookies are
  the session.
- Headless flow: POST creds → keep the `Set-Cookie` jar → send those cookies on
  every subsequent `/services/…` call (same cookie-session path tier-2 produces).
  (`Continue with Google`/`Apple` are a separate OAuth flow — out of scope for
  tier-1; tier-1 is the email/password form only.)
- **Cloudflare** in front (`/cdn-cgi/rum`); plain `fetch` with session cookies was
  NOT bot-walled during the spike (tier-3 transport stays a fallback).
- Frontend is a MobX SPA off `g0.evitecdn.com`; pages are server-rendered, so the
  data endpoints are best called directly (as the tools will) rather than scraped.

## Read endpoints (all confirmed)

### 1. List events — `GET /services/events/v1/`
Query: `filterBy` = `all|host|others` (**others = you're a guest**); `status`
(repeatable) = `upcoming|draft|archived|past|canceled`; `type=invitation`;
`offset`, `numResults`; `filter` (free text).
→ `{ events: Event[], totals }`. `totals` = `{ all, sending, draft, received,
canceled, past, upcoming, archived }` (sending=hosting, received=invited).
`Event`: `event_id, title, start, end, status, past, is_host, rsvp(yes|no|maybe),
guest_status(0|1|2), guest_id, host_id, host_name, location{location_name,
street_address, unit_num, city, state, zip_code, place_id}, timezone,
known_timezone_name, template_name, event_category, rsvp_off, is_invite,
is_pending_cohost, rendered_image_url, updated`. Fixture: `tests/fixtures/events-list.json`.

### 2. Event detail — `GET /services/event/v1/{id}`
→ top keys: `event, calculatedFields, design, location, userEventContext,
attributes, registries, settings, charity, gifting, rendered, calendar, features`.
- `event`: `id, title, message, startDatetime, endDatetime, knownTimezoneName,
  knownTimezoneAbbreviation, eventHostName, eventPhoneNumber, hostId, hostIds,
  status, isPast, eventType, category, superCategory, templateName, origin,
  isFabricPremium, shareableLink, sendOn`.
- `settings`: `enableMaybe, privateGuestList, headCountByFamily, plusOne,
  maxEventCapacity, allowViewMap, showGifting, rsvpBy, strictRsvpBy,
  enableHostPhotoGallery, enablePhotoSharing, allowGuestNumber, rsvpOff`.

### 3. Guests + RSVP summary — `GET /services/event/v1/{id}/guests/`
→ `{ guests: Guest[], summary }`.
- `Guest`: `guestId, userId, name, email, phone, guestType(host|cohost|guest),
  rsvpResponse(yes|no|maybe|noreply), numberOfAdults, numberOfKids, checkedIn,
  comments, deliveryStatus(delivered|…), inviteMethod(email|null), invitedBy,
  sentOn, timesViewed, avatarUrl, shortLink, longLink, created, updated`.
- `summary`: `{ yes, no, maybe, noReply, adultsYes, kidsYes, adultsMaybe,
  kidsMaybe, inviteesYes, inviteesMaybe, lockedStatus }` — this powers
  `evite_rsvp_summary`. Fixture: `tests/fixtures/event-guests.json`.

### 4. Messages — `GET /services/event/v1/{id}/posts/`
→ `{ posts: Post[] }` (the event's "Messages" tab; host/guest message thread).

## Writes (resource locations known; payloads ASSUMED — not yet captured)
All POST/PUT carry the **`csrftoken`** value as a CSRF header. Assumed header:
**`X-CSRFToken`** — `csrftoken` is Django's default CSRF *cookie* name, so
Django's default header `X-CSRFToken` is strongly indicated (centralized as
`CSRF_HEADER` in `src/client.ts`; one-line change once verified).
- **RSVP** — mutates a guest's response; target is the guest resource under
  `/services/event/v1/{id}/guests/…` (assumed `POST`/`PUT` with
  `rsvpResponse`, `numberOfAdults`, `numberOfKids`, optional comment — mirrors
  the verified READ `Guest` shape).
- **Send message** — `POST /services/event/v1/{id}/posts/` (the messages thread).
- **Create / edit event** — under `/services/event/v1/…`; create is likely
  multi-step (the site's create wizard).

### Live-capture attempt — BLOCKED (2026-06-01)
Tried a non-mutating capture (inject a `fetch`/XHR interceptor that records any
`/services/` write's method+url+body+headers, then **aborts** it so nothing
mutates). Could not exercise the write UIs in this account's current state:
- **0 upcoming / 0 draft events** (76 past/archived) → the RSVP widget and the
  message composer are not present/active on past events, so neither fires.
- **create-on-load POSTs are uncatchable** this way — the injected interceptor
  installs *after* page load, so a draft-create that fires during the customizer's
  initial render happens before the hook is in place. Only a write fired from a
  post-injection button click is interceptable.
- Gallery design cards are React-handled (no navigable design `href`s), and event
  IDs come back base64 (redacted in tool output), so the customizer can't be
  reached deterministically.
**To verify (issue #3):** redo the capture when the account has an upcoming or
draft event (RSVP + send-message exercise cleanly there), or get explicit
authorization for one reversible test write (e.g. toggle an RSVP and revert).

## Resolved spec Open Questions
- REST not GraphQL; base `/services/`, `events` (list) vs `event` (single).
- Session cookies `x-evite-session`/`evtsession`; CSRF `csrftoken`.
- Bot-wall: Cloudflare, not tripped by plain `fetch`.
- Pagination: `offset`+`numResults` with a `totals` breakdown.
- Single session observed → a multi-account registry is NOT needed for v1.

## Remaining (small) — see issue #1
Capture the exact write payloads (RSVP, send-message POST, create-event wizard)
by composing-but-not-submitting, and record as fixtures. All reads are done.
