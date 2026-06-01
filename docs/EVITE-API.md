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

## Writes — convention VERIFIED, most payloads still ASSUMED
All mutations carry the **`csrftoken`** cookie value in the **`X-CSRFToken`**
header — **VERIFIED** (live probe 2026-06-01): a constructed
`POST /services/event/v1/{id}/actions/cancel/` returned `202` with this header.
⚠️ The `csrftoken` cookie **ROTATES mid-session** — a stale value `403`s, a
freshly-read value succeeds. Read the cookie fresh per request (don't cache).

### TWO write API surfaces (live capture 2026-06-01)
Evite splits writes across two bases — this matters for every write tool:

**1. `/services/event/v1/{id}/actions/{verb}/` → `202`** — REST host actions on an
existing event. Mutations are **action sub-paths**, not PUT/POST to the bare
resource. VERIFIED against the real cancel write `POST …/actions/cancel/` (empty
body) → `202`, captured twice (delete-draft + cancel-event). Implemented as the
VERIFIED `EviteClient.cancelEvent()`.

**2. `/ajax/event/{id}/…`** — the legacy "ajax" API behind the create→guest→send
("Fabric") flow.
- **Add guest**: `POST /ajax/event/{id}/guestlist/draft/`. **Body partially
  reverse-engineered (active probe 2026-06-01):** a **top-level JSON array** of
  guest objects (`Content-Type: application/json`). The server does
  `for g in payload: DraftGuest(**g)` — proven by the `500` error
  *"DraftGuest() argument after ** must be a mapping, not str"* when a dict (whose
  iteration yields key strings) or form-encoded body was sent. `name`/`email` are
  *accepted* `DraftGuest` kwargs (no "unexpected keyword" error) but were
  **insufficient to persist** (200, but the guest didn't land — `DraftGuest` takes
  kwargs leniently). The exact persisting field set is still TBD: capture the
  stored guest shape via a real-pointer UI add (DOM `.click()` doesn't fire the
  React Save handler) then match it.
- Guest list (draft): `GET /ajax/event/{id}/guestlist/draft/?q=&search_by=all&search_type=contains&sort_by=&reverse=false&per_page=5000`
  → `{already_sent, guests:{page,current_page,has_next,count,num_pages}, letters, total_drafts, data_layer}`.
- Guest list (sent): `GET /ajax/event/{id}/guestlist/sent/?…&per_page=25&page=1`
- Contacts/import: `GET /ajax/event/{id}/guestlist/import/`, `…/guestlist/contacts`

So **guest/RSVP/send writes live under `/ajax/event/{id}/…`** (JSON arrays,
`X-CSRFToken`), while host lifecycle actions (cancel/reinstate) live under
`/services/…/actions/`. The event-detail create/save goes through the Fabric
editor's own (separate) API.

> ⚠️ Remaining: the exact `DraftGuest` *persisting* fields (name/email accepted but
> didn't persist) and the **RSVP** endpoint+body (not reached — needs a guest on a
> finalized event). `read_network_requests` exposes method+url+status but NOT the
> request body, so bodies must be reverse-engineered via probe responses (as above)
> or captured from the stored resource shape.

### Web routes (verified)
- Guest/event view: **`/event/{ID}`** (`evite.me/<short>` redirects here).
- Host dashboard: **`/event/{ID}/dashboard`** (+ `/dashboard/guests`).
- Editor/customizer: **`/invitation/{ID}/{design|details|gifting|review|add-guests}`**.
- My Events: **`/my-events/?status=upcoming|draft|archived…`** (draft delete is the
  `⋯ → Delete draft` overflow → `actions/cancel/`).
- Duplicate (from dashboard) creates a draft at `/invitation/{newID}` with
  `?source_event={srcID}`. The Details form fields (the event-write shape) are:
  `title`, `date` (`YYYY-MM-DD`, hidden) + time, `location`, `host`, `phone`,
  `event_option_max_guests`, plus gifting/signup-list fields and a custom `question`.

### Still UNVERIFIED (issue #3) — endpoints narrowed, bodies pending
- **RSVP / add guest** — under the `/ajax/event/{id}/guestlist/…` family (add-guest
  `POST …/guestlist/draft/` is verified). RSVP is likely a sibling guestlist/guest
  action; body mirrors the verified READ `Guest` shape (`rsvpResponse`,
  `numberOfAdults`, `numberOfKids`, comment).
- **Send invitation** — `/ajax/event/{id}/…` (the `guestlist/sent/` list is what
  "Send now" populates); exact send endpoint + body pending.
- **Send message** — `…/posts/` (read-verified location) or an `/ajax/event/{id}/…`
  sibling; body `{ message }`.
- **Create / update event** — the Fabric editor (`/invitation/{id}/{step}`) posts to
  its own API (neither `/services/` nor `/ajax/`); validation-gated (requires title,
  date, and edited sample text). On Finish the event reaches status `sending`.

### Capture methodology (lesson learned)
**Read writes at the browser/network layer (`read_network_requests`), NOT via an
in-page `fetch`/XHR monkeypatch** — Evite's SPA closes over `fetch` at module load,
so a late-injected wrapper never sees its calls (every in-page hook this session
captured 0 writes; the browser network log captured the `actions/cancel/` write
cleanly). What blocked the other three: RSVP has no host-edit-guest affordance in
the UI; send-message would notify the event's real (20) guests; create's save
posts off-`/services/`. Re-capture each when an **upcoming/draft event** exists or
with a guest present on a throwaway draft.

## Resolved spec Open Questions
- REST not GraphQL; base `/services/`, `events` (list) vs `event` (single).
- Session cookies `x-evite-session`/`evtsession`; CSRF `csrftoken`.
- Bot-wall: Cloudflare, not tripped by plain `fetch`.
- Pagination: `offset`+`numResults` with a `totals` breakdown.
- Single session observed → a multi-account registry is NOT needed for v1.

## Remaining (small) — see issue #1
Capture the exact write payloads (RSVP, send-message POST, create-event wizard)
by composing-but-not-submitting, and record as fixtures. All reads are done.
