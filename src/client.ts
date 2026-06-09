import { homedir } from 'node:os';
import { basename } from 'node:path';
import {
  buildQueryString,
  fileBlob,
  formatApiError,
  readFileHead,
  SessionNotAuthenticatedError,
} from '@chrischall/mcp-utils';
import { resolveSession, type ResolvedSession, type ResolveSessionOptions } from './auth.js';
import { mimetypeForPath, imageDimensions } from './image-meta.js';

/** Evite's photo-upload size cap (from the GCS signed-policy content-length-range). */
const MAX_UPLOAD_BYTES = 20_000_000;

/** Expand a leading `~` to the home directory (the only shell expansion we do). */
function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

/** The session-resolver signature the client depends on (injectable in tests). */
export type SessionResolver = (opts?: ResolveSessionOptions) => Promise<ResolvedSession>;

/** Base host for Evite's internal `/services/` API. */
const BASE_URL = 'https://www.evite.com';

/**
 * The request header carrying the CSRF token on writes.
 *
 * VERIFIED (live probe 2026-06-01): `X-CSRFToken` is correct — a constructed
 * `POST /services/event/v1/{id}/actions/cancel/` returned 202 with this header
 * carrying the current `csrftoken` cookie value. (`csrftoken` is Django's
 * default CSRF cookie; `X-CSRFToken` its default header.)
 *
 * IMPORTANT — the `csrftoken` cookie ROTATES within a session: a request with a
 * stale token 403s, a re-read fresh token succeeds. So the token value must be
 * read from the cookie jar fresh per request (the resolver re-reads it), not
 * cached. The header NAME is stable; only the value rotates.
 */
export const CSRF_HEADER = 'X-CSRFToken';

/** Health report surfaced by the `evite_healthcheck` tool. */
export interface EviteHealth {
  ok: boolean;
  /** `unresolved` before the first authenticated call; `resolved` after. */
  authMode: 'unresolved' | 'resolved';
  note: string;
}

/** The `status` filter values Evite's list endpoint accepts (repeatable). */
export type EventStatus = 'upcoming' | 'draft' | 'archived' | 'past' | 'canceled';

/** Arguments to {@link EviteClient.listEvents}. */
export interface ListEventsParams {
  filterBy: 'all' | 'host' | 'others';
  /** Repeatable status filter (emitted as repeated `status=` params). */
  status: EventStatus[];
  /** Fixed to `invitation` unless overridden. */
  type?: string;
  offset?: number;
  numResults?: number;
  /** Free-text filter. */
  filter?: string;
}

/** Shape of the list endpoint response: `{ events, totals }`. */
export interface ListEventsResult {
  events: unknown[];
  totals: Record<string, number>;
}

/** Shape of the guests endpoint response: `{ guests, summary }`. */
export interface ListGuestsResult {
  guests: unknown[];
  summary: Record<string, unknown>;
}

/** Shape of the posts endpoint response: `{ posts }`. */
export interface ListMessagesResult {
  posts: unknown[];
}

/** An RSVP response value (mirrors the read `rsvpResponse` field). */
export type RsvpResponse = 'yes' | 'no' | 'maybe';

/** Arguments to {@link EviteClient.rsvp}. */
export interface RsvpInput {
  response: RsvpResponse;
  numberOfAdults: number;
  numberOfKids: number;
  /** Optional note/comment (maps to the guest `comments` field). */
  note?: string;
}

/** Arguments to {@link EviteClient.sendMessage}. */
export interface SendMessageInput {
  message: string;
}

/** Arguments to {@link EviteClient.broadcast}. */
export interface BroadcastInput {
  message: string;
  /** RSVP segments to broadcast to, e.g. ['yes', 'no', 'maybe']. */
  groups: string[];
  /** Recipient count the web UI sends along (informational); optional. */
  participantCount?: number;
}

/** Arguments to {@link EviteClient.uploadPhoto}. */
export interface UploadPhotoInput {
  /** Path to the local image file (a leading `~` is expanded). */
  path: string;
  /** The uploader's guest id on the event (from {@link EviteClient.listGuests}). */
  guestId: string;
  /** Override the mimetype — otherwise inferred from the file extension. */
  mimetype?: string;
}

/** Result of {@link EviteClient.uploadPhoto}. */
export interface UploadPhotoResult {
  /** The id Evite assigned the photo. */
  photoId: string;
  /** A direct URL to the stored image, when the ticket returned one. */
  accessUrl?: string;
}

/** The signed-upload ticket returned by `POST …/upload/request/`. */
interface UploadTicket {
  /** The GCS endpoint to POST the multipart upload to. */
  upload_url: string;
  /** A direct (signed) URL to the stored object. */
  access_url?: string;
  /** The object path; its last segment is the photo id. */
  gcs_path?: string;
  /** The GCS signed-POST form fields (key, policy, signature, …) sent before `file`. */
  upload_form: Record<string, string>;
}

/** A guest to add to an event's draft guest list ({@link EviteClient.addGuest}). */
export interface GuestDraft {
  name: string;
  email: string;
}

/** New values for a draft guest ({@link EviteClient.updateGuest}). */
export interface GuestPatch {
  name: string;
  email: string;
  phone?: string;
}

/**
 * Event-create input. The create API requires `title`, `startDatetime`, and
 * `templateName` (extra keys are passed through under the `event` envelope).
 */
export interface CreateEventInput {
  title: string;
  /** Required by the create API (Pydantic). */
  startDatetime: string;
  /** Required by the create API (Pydantic). */
  templateName: string;
  endDatetime?: string;
  message?: string;
  [key: string]: unknown;
}

/** A partial patch for {@link EviteClient.updateEvent}. */
export interface UpdateEventPatch {
  [key: string]: unknown;
}

/** An invitation template ({@link EviteClient.listTemplates}). */
export interface Template {
  /** The template slug — pass this as `template_name` to {@link EviteClient.createEvent}. */
  templateName: string;
  /** A readable name derived from the slug (e.g. `camp-confetti_vanilla_kids` → "Camp Confetti"). */
  displayName: string;
}

/** Result of {@link EviteClient.listTemplates}. */
export interface ListTemplatesResult {
  category: string;
  count: number;
  templates: Template[];
}

/** Result of {@link EviteClient.duplicateEvent}. */
export interface DuplicateResult {
  /** The id of the newly-created draft event. */
  newEventId: string;
  /** The editor URL the copy redirects to (carries `source_event`). */
  customizeUrl: string;
}

/** Injectable dependencies (tests inject a fake session resolver). */
export interface EviteClientOptions {
  /** Resolve the session. Defaults to {@link resolveSession}. */
  resolveSession?: SessionResolver;
}

/**
 * Authenticated HTTP client over Evite's internal `/services/` API.
 *
 * Construction never touches the network or credentials — the session is
 * resolved lazily on the first call (deferred-config-error: an MCP host can
 * list tools even with no session configured; the error surfaces at call time).
 */
export class EviteClient {
  private readonly resolver: SessionResolver;
  private session: ResolvedSession | undefined;
  private resolving: Promise<ResolvedSession> | undefined;

  constructor(opts: EviteClientOptions = {}) {
    this.resolver = opts.resolveSession ?? resolveSession;
  }

  /** Report status and whether a session has been resolved yet. */
  health(): EviteHealth {
    const resolved = this.session !== undefined;
    return {
      ok: true,
      authMode: resolved ? 'resolved' : 'unresolved',
      note: resolved
        ? 'Authenticated against the Evite internal /services API.'
        : 'No call made yet — session resolves lazily on first use.',
    };
  }

  /**
   * Resolve (and memoize) the session, serializing concurrent first calls.
   * Only successful resolutions are memoized — a rejected in-flight promise is
   * cleared so the next call retries the resolver instead of rethrowing a
   * cached transient failure (network blip, bridge hiccup, 5xx during login)
   * forever.
   */
  private async getSession(): Promise<ResolvedSession> {
    if (this.session) return this.session;
    if (!this.resolving) {
      this.resolving = this.resolver().catch((err: unknown) => {
        // A new attempt is only created while `resolving` is unset, and this
        // handler runs at rejection time — so it can only be clearing itself.
        this.resolving = undefined;
        throw err;
      });
    }
    const session = await this.resolving;
    this.session = session;
    return session;
  }

  /**
   * Issue an authenticated GET. `query` (when present) is appended; `status`
   * arrays become repeated params via {@link buildQueryString}. Maps 401/403 to
   * {@link SessionNotAuthenticatedError}; other non-2xx through
   * {@link formatApiError} (redaction + truncation — no token/body leakage).
   */
  private async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    const session = await this.getSession();
    const qs = query ? buildQueryString(query) : '';
    const url = `${BASE_URL}${path}${qs}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { cookie: session.cookieHeader, accept: 'application/json' },
    });

    if (response.status === 401 || response.status === 403) {
      throw new SessionNotAuthenticatedError('Evite', 'https://www.evite.com');
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(formatApiError(response.status, 'GET', path, body, { service: 'Evite' }));
    }

    return (await response.json()) as T;
  }

  /** `GET /services/events/v1/` — your events list. `events` (plural) = list. */
  async listEvents(params: ListEventsParams): Promise<ListEventsResult> {
    return this.get<ListEventsResult>('/services/events/v1/', {
      filterBy: params.filterBy,
      status: params.status,
      type: params.type ?? 'invitation',
      offset: params.offset,
      numResults: params.numResults,
      filter: params.filter,
    });
  }

  /** `GET /services/event/v1/{id}` — single-event detail. `event` (singular). */
  async getEvent(eventId: string): Promise<unknown> {
    return this.get<unknown>(`/services/event/v1/${encodeURIComponent(eventId)}`);
  }

  /** `GET /services/event/v1/{id}/guests/` — guest list + RSVP summary. */
  async listGuests(eventId: string): Promise<ListGuestsResult> {
    return this.get<ListGuestsResult>(`/services/event/v1/${encodeURIComponent(eventId)}/guests/`);
  }

  /** Authenticated GET returning the raw response text (for the SSR gallery pages). */
  private async getHtml(path: string): Promise<string> {
    const session = await this.getSession();
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: { cookie: session.cookieHeader, accept: 'text/html' },
    });
    if (response.status === 401 || response.status === 403) {
      throw new SessionNotAuthenticatedError('Evite', 'https://www.evite.com');
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(formatApiError(response.status, 'GET', path, body, { service: 'Evite' }));
    }
    return response.text();
  }

  /**
   * List invitation templates from a gallery category — the source of the
   * `template_name` that {@link createEvent} requires.
   *
   * Evite's gallery is server-rendered (no JSON API), so this scrapes the
   * category page HTML for the template slugs in `/invitation/{slug}/…` links
   * (verified: the SSR markup carries every card's slug). `freeOnly` adds the
   * `free` price filter so the page renders only free templates.
   */
  async listTemplates(category: string, freeOnly = false): Promise<ListTemplatesResult> {
    const path =
      `/invites/${category.replace(/^\/+|\/+$/g, '')}/` +
      (freeOnly ? '?active_filter=free_premium%2Cfree' : '');
    const html = await this.getHtml(path);

    const slugs = new Set<string>();
    const re = /\/invitation\/([a-z0-9][a-z0-9_-]+?)\/(?:create|preview|details)/gi;
    for (const m of html.matchAll(re)) slugs.add(m[1]!.toLowerCase());

    const templates: Template[] = [...slugs].map((templateName) => ({
      templateName,
      // "camp-confetti_vanilla_kids" → "Camp Confetti"
      displayName: templateName
        .split('_')[0]!
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '),
    }));

    return { category, count: templates.length, templates };
  }

  /** The `summary` slice of {@link listGuests} — powers `evite_rsvp_summary`. */
  async rsvpSummary(eventId: string): Promise<Record<string, unknown>> {
    const { summary } = await this.listGuests(eventId);
    return summary;
  }

  /** `GET /services/event/v1/{id}/posts/` — the event's "Messages" thread. */
  async listMessages(eventId: string): Promise<ListMessagesResult> {
    return this.get<ListMessagesResult>(`/services/event/v1/${encodeURIComponent(eventId)}/posts/`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Writes
  //
  // SAFETY: these are the ONLY methods that mutate Evite. They are reached only
  // when a write tool is called with `confirm: true` — the default path returns
  // a dry-run preview without ever touching the network.
  //
  // CSRF: all writes send the current `csrftoken` cookie in `X-CSRFToken`
  // (VERIFIED). The cookie ROTATES mid-session — the resolver must read it fresh
  // per request (a stale value 403s).
  //
  // VERIFIED endpoints (live probe 2026-06-01) — across THREE bases:
  //  - {@link rsvp}            PUT  /services/event/v1/{id}/guests/{guestId}        → 200
  //  - {@link createEvent}     POST /services/event/v1/           body {event:{…}}  → creates (500-on-success)
  //  - {@link updateEvent}     PATCH /services/event/v1/{id}      body {event:{…}}  → 200
  //  - {@link sendInvitation}  POST /services/event/v1/{id}/send/                   → sends drafts
  //  - {@link cancelEvent}     POST /services/event/v1/{id}/actions/cancel/         → 202
  //  - {@link reinstateEvent}  POST /services/event/v1/{id}/actions/reinstate/      → 202
  //  - add-guest               POST /ajax/event/{id}/guestlist/draft/  body [{name,email}]
  //  - {@link sendMessage}     POST /tsunami/v1/services/event/{id}/guest/{gid}/messages
  //  - {@link broadcast}       POST /tsunami/v1/services/event/{id}/broadcast/   body fully captured
  // Three bases: REST `/services/…`, legacy `/ajax/event/{id}/…` (guest list), and
  // the `/tsunami/…` messaging service. Body fields for send/sendMessage are still
  // assumed (only endpoints captured — observer gives URL, not body; see issue #3);
  // broadcast's body, by contrast, was fully captured.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Issue an authenticated mutating request (POST/PUT/PATCH). The CSRF token
   * (when the session resolved one) is attached via {@link CSRF_HEADER} — the
   * single, centralized place that header is set. Error mapping mirrors {@link get}.
   */
  private async write<T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    // `unknown` (not just an object): the add-guest write sends a top-level JSON array.
    // `undefined` → no request body (e.g. the DELETE remove-guest call).
    body?: unknown,
  ): Promise<T> {
    const session = await this.getSession();
    const url = `${BASE_URL}${path}`;

    const headers: Record<string, string> = {
      cookie: session.cookieHeader,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (session.csrfToken) headers[CSRF_HEADER] = session.csrfToken;

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401 || response.status === 403) {
      throw new SessionNotAuthenticatedError('Evite', 'https://www.evite.com');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(formatApiError(response.status, method, path, text, { service: 'Evite' }));
    }

    return (await response.json().catch(() => ({}))) as T;
  }

  /**
   * RSVP for a guest — mutates the guest resource via
   * **`PUT /services/event/v1/{id}/guests/{guestId}`** → `200`.
   *
   * VERIFIED (live probe 2026-06-01): the `PUT` to this path was accepted (200,
   * echoing the guest); the sibling candidates — `POST` to the same path,
   * `/actions/rsvp/`, and the `/ajax/…/rsvp/` forms — all `404`. The body keys
   * (`rsvpResponse`, `numberOfAdults`, `numberOfKids`, `comments`) match the
   * confirmed READ guest shape and were accepted without a 400.
   */
  async rsvp(eventId: string, guestId: string, input: RsvpInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      rsvpResponse: input.response,
      numberOfAdults: input.numberOfAdults,
      numberOfKids: input.numberOfKids,
    };
    if (input.note !== undefined) body.comments = input.note;
    return this.write(
      'PUT',
      `/services/event/v1/${encodeURIComponent(eventId)}/guests/${encodeURIComponent(guestId)}`,
      body,
    );
  }

  /**
   * Send a private host→guest message —
   * **`POST /tsunami/v1/services/event/{eventId}/guest/{guestId}/messages`**.
   *
   * VERIFIED endpoint (live probe 2026-06-01): the host "Send message" flow hits
   * this `/tsunami/` messaging service per guest — NOT `/services/…/posts/` (which
   * is GET-only, `405` on writes). Body assumed `{ message }` (the send fired this
   * endpoint; the exact body field wasn't captured — issue #3).
   */
  async sendMessage(
    eventId: string,
    guestId: string,
    input: SendMessageInput,
  ): Promise<unknown> {
    return this.write(
      'POST',
      `/tsunami/v1/services/event/${encodeURIComponent(eventId)}/guest/${encodeURIComponent(guestId)}/messages`,
      { message: input.message },
    );
  }

  /**
   * Broadcast a message to whole RSVP segments at once —
   * **`POST /tsunami/v1/services/event/{eventId}/broadcast/`**.
   *
   * VERIFIED endpoint + body (captured curl 2026-06-01): the host "Message guests"
   * broadcast hits the `/tsunami/` messaging service's `/broadcast/` path (NOT the
   * per-guest `…/guest/{id}/messages` of {@link sendMessage}). The body is
   * `{ message, captcha: null, participantCount?, virtual_groups: [...] }`, where
   * `virtual_groups` names the RSVP segments to reach (e.g. `['yes','maybe']`).
   * This really emails every guest in those segments.
   */
  async broadcast(eventId: string, input: BroadcastInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      message: input.message,
      captcha: null,
      virtual_groups: input.groups,
    };
    if (input.participantCount !== undefined) body.participantCount = input.participantCount;
    return this.write(
      'POST',
      `/tsunami/v1/services/event/${encodeURIComponent(eventId)}/broadcast/`,
      body,
    );
  }

  /**
   * Upload a photo to an event's shared gallery — a 4-step Google Cloud Storage
   * signed-upload flow (VERIFIED from a captured upload ticket, 2026-06-02):
   *
   *   1. `POST /services/photos/v1/{eventId}/upload/request/` (cookies + CSRF) →
   *      returns `{ upload_url, upload_form:{key,policy,signature,…}, access_url }`,
   *      a GCS signed-POST ticket with the photo id embedded in `upload_form.key`.
   *   2. `POST {upload_url}` to **GCS** as multipart — the signed-POST fields first,
   *      then `file` last (no Evite cookies; the policy is the auth). GCS replies
   *      `303` with `Location:` = the Evite finish URL.
   *   3. `GET` that finish URL (cookies) to finalize the object into the album.
   *   4. `POST /services/photos/v1/{eventId}/shared-gallery/?gid={guestId}` (cookies
   *      + CSRF), body `{ photo_ids:[photoId] }` — registers it in the gallery.
   *
   * The GCS policy enforces `Content-Type == mimetype` and a 20 MB cap, so the
   * mimetype declared in step 1 must match the Blob's type in step 2.
   */
  async uploadPhoto(eventId: string, input: UploadPhotoInput): Promise<UploadPhotoResult> {
    const abs = expandHome(input.path);
    const mimetype = input.mimetype ?? mimetypeForPath(abs);
    if (!mimetype) {
      throw new Error(
        `Unknown image type for "${input.path}" — use a .jpg/.png/.gif/.webp/.heic file or pass mimetype.`,
      );
    }
    // A FILE-BACKED Blob: `fetch` streams the bytes off disk as it sends the
    // multipart body, so a 20 MB photo never becomes a 20 MB Buffer in memory.
    // Both file operations live in one try so any read-time I/O error (the
    // file vanishing between awaits, EACCES, …) surfaces as the friendly
    // message rather than a raw Node error. Dimensions need only the header,
    // so readFileHead pulls just the first 64 KB off disk.
    let blob: Blob;
    let head: Buffer;
    try {
      blob = await fileBlob(abs, { type: mimetype });
      head = await readFileHead(abs, 65_536);
    } catch {
      throw new Error(`Cannot read image file: ${input.path}`);
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `Image is ${blob.size} bytes; Evite's photo upload limit is ${MAX_UPLOAD_BYTES}.`,
      );
    }
    const { width, height } = imageDimensions(head, mimetype);

    // ── Step 1: signed-upload ticket from Evite.
    const ticket = await this.write<UploadTicket>(
      'POST',
      `/services/photos/v1/${encodeURIComponent(eventId)}/upload/request/`,
      {
        upload_path: 'feed_photos',
        event_id: eventId,
        photo_id: '',
        guest_id: input.guestId,
        redirect: true,
        mimetype,
        width,
        height,
      },
    );
    if (!ticket?.upload_url || !ticket.upload_form) {
      throw new Error('Evite upload/request did not return a usable upload ticket.');
    }
    const photoId =
      (ticket.upload_form.key ?? ticket.gcs_path ?? '').split('/').filter(Boolean).pop() ?? '';
    if (!photoId) throw new Error('Could not determine the photo id from the upload ticket.');

    // ── Step 2: multipart POST to GCS (signed fields first, then `file`; no cookies).
    const form = new FormData();
    for (const [name, value] of Object.entries(ticket.upload_form)) form.append(name, value);
    /* v8 ignore next -- basename of a readable absolute path is never empty; `|| 'photo'` is a defensive fallback */
    const filename = basename(abs) || 'photo';
    form.append('file', blob, filename);

    const gcs = await fetch(ticket.upload_url, { method: 'POST', body: form, redirect: 'manual' });
    // Success is a 303 redirect (to success_action_redirect); accept 2xx too.
    if (gcs.status !== 303 && !gcs.ok) {
      const text = await gcs.text().catch(() => '');
      throw new Error(
        formatApiError(gcs.status, 'POST', ticket.upload_url, text, {
          service: 'Google Cloud Storage',
        }),
      );
    }
    const finishUrl = gcs.headers.get('location') ?? ticket.upload_form.success_action_redirect ?? '';

    // ── Step 3: hit Evite's finish endpoint (cookies) to finalize the object.
    // Best-effort: GCS already holds the object (Step 2's 303 success), and Step 4
    // registers it from the upload-ticket key — neither depends on this call. A
    // finish-endpoint hiccup must not fail an upload that otherwise succeeded, so
    // the error is intentionally swallowed.
    if (finishUrl) {
      const u = new URL(finishUrl, BASE_URL);
      await this.getHtml(`${u.pathname}${u.search}`).catch(() => undefined);
    }

    // ── Step 4: register the photo in the event's shared gallery.
    await this.write(
      'POST',
      `/services/photos/v1/${encodeURIComponent(eventId)}/shared-gallery/?gid=${encodeURIComponent(input.guestId)}`,
      { photo_ids: [photoId] },
    );

    const result: UploadPhotoResult = { photoId };
    if (ticket.access_url) result.accessUrl = ticket.access_url;
    return result;
  }

  /**
   * Add guests to the event's draft (un-sent) guest list —
   * **`POST /ajax/event/{id}/guestlist/draft/`**, body a top-level JSON array
   * `[{ name, email }, …]`.
   *
   * VERIFIED (live probe 2026-06-01): the array shape was pinned by the server's
   * `DraftGuest(**g)` error; the guest persists (`count` 0→1) and the server fills
   * `guest_id`/`invite_method`/etc. Safe — adds to the DRAFT list, so nothing is
   * sent until {@link sendInvitation}. NB: a guest only persists once the event is
   * finalized (status `sending`); on a bare `draft` the POST 200s but drops it.
   */
  async addGuest(eventId: string, guests: GuestDraft[]): Promise<unknown> {
    return this.write(
      'POST',
      `/ajax/event/${encodeURIComponent(eventId)}/guestlist/draft/`,
      guests,
    );
  }

  /**
   * Edit a draft (un-sent) guest's name / email / phone —
   * **`PATCH /ajax/event/{id}/guestlist/draft/`** → `200`.
   *
   * VERIFIED (live capture 2026-06-01): the site issues this PATCH with the full
   * guest object `{guest_id, email, name, phone, event_id, invite_method}`; the
   * `guest_id` selects the guest, the other fields are the new values.
   */
  async updateGuest(eventId: string, guestId: string, patch: GuestPatch): Promise<unknown> {
    return this.write('PATCH', `/ajax/event/${encodeURIComponent(eventId)}/guestlist/draft/`, {
      guest_id: guestId,
      event_id: eventId,
      invite_method: 'email',
      name: patch.name,
      email: patch.email,
      phone: patch.phone ?? '',
    });
  }

  /**
   * Remove a draft (un-sent) guest —
   * **`DELETE /ajax/event/{id}/guestlist/draft/{guestId}`** (no body) → `200`.
   *
   * VERIFIED (live capture 2026-06-01): the guest-list "trash" control issues
   * exactly this DELETE.
   */
  async removeGuest(eventId: string, guestId: string): Promise<unknown> {
    return this.write(
      'DELETE',
      `/ajax/event/${encodeURIComponent(eventId)}/guestlist/draft/${encodeURIComponent(guestId)}`,
    );
  }

  /**
   * Send the invitation ("Send now") to the event's ready-to-send (draft) guests —
   * **`POST /services/event/v1/{id}/send/`**.
   *
   * VERIFIED endpoint (live probe 2026-06-01): "Send now" fired exactly this path
   * before delivering to the draft guests. Body assumed empty (it sends whatever
   * is in the draft guest list); the exact body wasn't captured — issue #3.
   * NOTE: this actually emails guests — keep it strictly confirm-gated.
   */
  async sendInvitation(eventId: string): Promise<unknown> {
    return this.write('POST', `/services/event/v1/${encodeURIComponent(eventId)}/send/`, {});
  }

  /**
   * Create an event — `POST /services/event/v1/` with the fields wrapped in an
   * `event` envelope. Required fields (named by the API's Pydantic validation):
   * `title`, `startDatetime`, `templateName`.
   *
   * VERIFIED (live probe 2026-06-01) — with caveat: this request DID create a
   * draft event (it appeared in My Events as a `draft`). BUT the API returns
   * `500 "Unknown error"` even on that success (a secondary post-create step
   * fails), so {@link write} will THROW despite the event existing. Until that's
   * understood, treat a 500 from this call as "possibly created" — re-query the
   * draft list rather than retrying blindly. See issue #3.
   */
  async createEvent(input: CreateEventInput): Promise<unknown> {
    return this.write('POST', '/services/event/v1/', { event: { ...input } });
  }

  /**
   * Edit an event — **`PATCH /services/event/v1/{id}`** with the patch wrapped in
   * an `event` envelope → `200`.
   *
   * VERIFIED (live probe 2026-06-01): `PATCH` with `{event:{title}}` changed the
   * title (200); a bare `{title}` 200'd but was a no-op, `PUT` 500'd. So the
   * method is PATCH and the body must nest the fields under `event`.
   */
  async updateEvent(eventId: string, patch: UpdateEventPatch): Promise<unknown> {
    return this.write('PATCH', `/services/event/v1/${encodeURIComponent(eventId)}`, {
      event: { ...patch },
    });
  }

  /**
   * Cancel an event (also the "delete draft" action) —
   * `POST /services/event/v1/{id}/actions/cancel/`, empty body, → 202 Accepted.
   *
   * VERIFIED (live probe 2026-06-01): the exact request the site issues to remove
   * a draft / cancel an event; the template for the `/actions/{verb}/` convention.
   */
  async cancelEvent(eventId: string): Promise<unknown> {
    return this.write(
      'POST',
      `/services/event/v1/${encodeURIComponent(eventId)}/actions/cancel/`,
      {},
    );
  }

  /**
   * Reinstate a previously-canceled event —
   * `POST /services/event/v1/{id}/actions/reinstate/`, empty body, → 202 Accepted.
   *
   * VERIFIED (live probe 2026-06-01): the inverse of {@link cancelEvent}; restores
   * a `cancelled` event back to `sending`.
   */
  async reinstateEvent(eventId: string): Promise<unknown> {
    return this.write(
      'POST',
      `/services/event/v1/${encodeURIComponent(eventId)}/actions/reinstate/`,
      {},
    );
  }

  /**
   * Duplicate an event into a fresh draft —
   * **`GET /plus/create/{id}/copy/`** → `302` →
   * `Location: /invitation/{newId}/customize?…&source_event={id}`.
   *
   * VERIFIED (live capture 2026-06-01): the "Duplicate event" action is a GET to
   * the copy path that 302-redirects to the new draft's editor; the new event id
   * is the `/invitation/{newId}/` segment of the redirect target.
   */
  async duplicateEvent(eventId: string): Promise<DuplicateResult> {
    const session = await this.getSession();
    const url = `${BASE_URL}/plus/create/${encodeURIComponent(eventId)}/copy/?previous=my_events`;
    const headers: Record<string, string> = {
      cookie: session.cookieHeader,
      accept: 'text/html',
    };
    if (session.csrfToken) headers[CSRF_HEADER] = session.csrfToken;

    const response = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
    if (response.status === 401 || response.status === 403) {
      throw new SessionNotAuthenticatedError('Evite', 'https://www.evite.com');
    }
    const location = response.headers.get('location') ?? '';
    const match = location.match(/\/invitation\/([^/?]+)\//);
    if (!match) {
      // Non-redirect (e.g. a 500): the Location header is empty here, so read the
      // actual response body for the error message, falling back to `location`.
      // `.catch(() => '')` mirrors get()/write(); `body || location` keeps any
      // non-matching Location as a last resort.
      const body = await response.text().catch(() => '');
      throw new Error(
        formatApiError(response.status, 'GET', '/plus/create/{id}/copy/', body || location, {
          service: 'Evite',
        }),
      );
    }
    return { newEventId: match[1]!, customizeUrl: location };
  }
}
