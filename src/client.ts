import {
  buildQueryString,
  formatApiError,
  SessionNotAuthenticatedError,
} from '@chrischall/mcp-utils';
import { resolveSession, type ResolvedSession, type ResolveSessionOptions } from './auth.js';

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

/**
 * Best-effort event-create input. The real create flow is the site's multi-step
 * wizard; this single-POST shape is a placeholder until the wizard is captured.
 */
export interface CreateEventInput {
  title: string;
  startDatetime?: string;
  endDatetime?: string;
  message?: string;
  [key: string]: unknown;
}

/** A partial patch for {@link EviteClient.updateEvent}. */
export interface UpdateEventPatch {
  [key: string]: unknown;
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

  /** Resolve (and memoize) the session, serializing concurrent first calls. */
  private async getSession(): Promise<ResolvedSession> {
    if (this.session) return this.session;
    if (!this.resolving) {
      this.resolving = this.resolver();
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
  // Three bases: REST `/services/…`, legacy `/ajax/event/{id}/…` (guest list), and
  // the `/tsunami/…` messaging service. Body fields for send/sendMessage are
  // assumed (only endpoints captured — observer gives URL, not body); see issue #3.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Issue an authenticated mutating request (POST/PUT/PATCH). The CSRF token
   * (when the session resolved one) is attached via {@link CSRF_HEADER} — the
   * single, centralized place that header is set. Error mapping mirrors {@link get}.
   */
  private async write<T>(
    method: 'POST' | 'PUT' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const session = await this.getSession();
    const url = `${BASE_URL}${path}`;

    const headers: Record<string, string> = {
      cookie: session.cookieHeader,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    // TODO(verify): confirm CSRF header name with a live write capture (issue #3).
    if (session.csrfToken) headers[CSRF_HEADER] = session.csrfToken;

    const response = await fetch(url, { method, headers, body: JSON.stringify(body) });

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
}
