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
 * Evite's frontend exposes the token as the `csrftoken` cookie (and
 * `window.fetchproxyCsrf`); the exact header NAME it echoes back on mutating
 * requests was never captured (capturing it needs a real compose-and-submit,
 * which the live-capture session could not exercise — see issue #3).
 *
 * Best-informed assumption: `csrftoken` is Django's default CSRF *cookie* name
 * (`CSRF_COOKIE_NAME`), so Django's default CSRF *header* `X-CSRFToken`
 * (`CSRF_HEADER_NAME = HTTP_X_CSRFTOKEN`) is the strongly-indicated header.
 *
 * TODO(verify): confirm CSRF header name with a live write capture (issue #3).
 * Centralized here so flipping it to whatever the capture reveals (e.g.
 * `X-CSRF-Token`, or moving it into the body as a field) is a one-line change.
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
  // VERIFIED (live capture 2026-06-01): Evite splits writes across TWO bases —
  //  1. host lifecycle actions: `POST /services/event/v1/{id}/actions/{verb}/`
  //     → 202 (NOT PUT/POST to the bare resource). Confirmed via cancel, captured
  //     twice. {@link cancelEvent} is VERIFIED.
  //  2. guest/RSVP/send flow: `/ajax/event/{id}/…` (e.g. add-guest
  //     `POST /ajax/event/{id}/guestlist/draft/` → 200, captured live).
  // So rsvp/sendMessage most likely live under `/ajax/event/{id}/…`, not the
  // `/services/` path stubbed below; createEvent goes through the Fabric editor's
  // own API. Those three stay UNVERIFIED (endpoints narrowed, BODIES pending —
  // see issue #3 + docs/EVITE-API.md). Capture note: read writes at the
  // browser/network layer — the SPA closes over `fetch` at load, so an in-page
  // monkeypatch never sees its calls (and that layer doesn't expose request bodies).
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Issue an authenticated mutating request (POST/PUT). The CSRF token (when the
   * session resolved one) is attached via {@link CSRF_HEADER} — the single,
   * centralized place that header is set, so adjusting it after a live capture
   * is one edit. Error mapping mirrors {@link get}.
   */
  private async write<T>(
    method: 'POST' | 'PUT',
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
   * RSVP for a guest — mutates the guest resource under
   * `POST /services/event/v1/{id}/guests/{guestId}`.
   *
   * UNVERIFIED payload — see issue #3. Field names (`rsvpResponse`,
   * `numberOfAdults`, `numberOfKids`, `comments`) mirror the confirmed READ
   * guest shape, but the write contract (method, exact keys) is a guess until a
   * live compose-capture confirms it.
   */
  async rsvp(eventId: string, guestId: string, input: RsvpInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      rsvpResponse: input.response,
      numberOfAdults: input.numberOfAdults,
      numberOfKids: input.numberOfKids,
    };
    if (input.note !== undefined) body.comments = input.note;
    return this.write(
      'POST',
      `/services/event/v1/${encodeURIComponent(eventId)}/guests/${encodeURIComponent(guestId)}`,
      body,
    );
  }

  /**
   * Post a message to the event's Messages thread —
   * `POST /services/event/v1/{id}/posts/`.
   *
   * UNVERIFIED payload — see issue #3. The endpoint is the confirmed READ posts
   * location; the write body (`{ message }`) is unconfirmed.
   */
  async sendMessage(eventId: string, input: SendMessageInput): Promise<unknown> {
    return this.write('POST', `/services/event/v1/${encodeURIComponent(eventId)}/posts/`, {
      message: input.message,
    });
  }

  /**
   * Create an event — `POST /services/event/v1/`.
   *
   * UNVERIFIED payload — see issue #3. NOTE: the real site flow is a multi-step
   * create wizard; this single POST is a best-effort placeholder and will likely
   * need to walk multiple wizard steps once captured.
   */
  async createEvent(input: CreateEventInput): Promise<unknown> {
    return this.write('POST', '/services/event/v1/', { ...input });
  }

  /**
   * Edit an event — `PUT /services/event/v1/{id}` with a partial patch.
   *
   * UNVERIFIED payload — see issue #3. Method (PUT vs PATCH) and accepted keys
   * are unconfirmed.
   */
  async updateEvent(eventId: string, patch: UpdateEventPatch): Promise<unknown> {
    return this.write('PUT', `/services/event/v1/${encodeURIComponent(eventId)}`, { ...patch });
  }

  /**
   * Cancel an event (also the "delete draft" action) —
   * `POST /services/event/v1/{id}/actions/cancel/`, empty body, → 202 Accepted.
   *
   * VERIFIED against a live write capture (2026-06-01): this is the exact request
   * the site issues to remove a draft. The only confirmed mutating endpoint, and
   * the template for the `/actions/{verb}/` convention the other writes follow.
   */
  async cancelEvent(eventId: string): Promise<unknown> {
    return this.write(
      'POST',
      `/services/event/v1/${encodeURIComponent(eventId)}/actions/cancel/`,
      {},
    );
  }
}
