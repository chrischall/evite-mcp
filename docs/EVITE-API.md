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

## Writes (resource locations known; capture payloads when implementing)
All POST/PUT with the **`csrftoken`** value as the CSRF header/field (exact header
TBD from one compose-capture — compose, inspect the request, do NOT submit):
- **RSVP** — mutates a guest's response; target is the guest resource under
  `/services/event/v1/{id}/guests/…` (likely `POST`/`PUT` with
  `rsvpResponse`, `numberOfAdults`, `numberOfKids`, optional comment).
- **Send message** — `POST /services/event/v1/{id}/posts/` (the messages thread).
- **Create / edit event** — under `/services/event/v1/…`; create is likely
  multi-step (the site's create wizard). Capture by walking one wizard step.

## Resolved spec Open Questions
- REST not GraphQL; base `/services/`, `events` (list) vs `event` (single).
- Session cookies `x-evite-session`/`evtsession`; CSRF `csrftoken`.
- Bot-wall: Cloudflare, not tripped by plain `fetch`.
- Pagination: `offset`+`numResults` with a `totals` breakdown.
- Single session observed → a multi-account registry is NOT needed for v1.

## Remaining (small) — see issue #1
Capture the exact write payloads (RSVP, send-message POST, create-event wizard)
by composing-but-not-submitting, and record as fixtures. All reads are done.
