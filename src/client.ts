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
}
