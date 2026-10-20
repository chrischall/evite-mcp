import {
  McpToolError,
  WriteOutcomeUnknownError,
  describeTransportFailure,
  withAmbientCancellation,
} from '@chrischall/mcp-utils';

/**
 * The one transport every Evite / Firebase / GCS request goes through
 * (fleet-audit #1188). Before it, every call was a bare `fetch` with no
 * deadline and no cancellation: a stalled www.evite.com connection held the
 * tool call open until the host gave up, and — because the session manager
 * single-flights the login — one stalled `/ajax_login` held every concurrent
 * call with it. Worse, a write whose connection failed AFTER Evite committed it
 * surfaced as a raw `TypeError('fetch failed')`, which reads as "safe to
 * retry": a retried evite_broadcast re-emails every yes/maybe guest.
 *
 * Why not `createApiClient`: it throws on any non-2xx, while `write()` must
 * read a 401/403 response itself (the rotated-CSRF replay, `classify403`) and
 * `CookieSessionManager.isExpired` must see the raw `Response`. So this wraps
 * `fetch` with the same three guarantees instead: mcp-utils' 30 s deadline,
 * the MCP call's cancellation, and {@link WriteOutcomeUnknownError} for a
 * write that got no answer. A read that got no answer throws mcp-utils'
 * `describeTransportFailure` (host + cause code + hint) instead of the bare
 * `TypeError('fetch failed')`.
 */

/** Per-request deadline — mcp-utils' DEFAULT_REQUEST_TIMEOUT_MS. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The hint on an Evite write whose outcome is unknown: check, then decide. */
export const WRITE_OUTCOME_HINT =
  'Evite may already have applied this. Check before retrying — evite_list_messages and evite_list_guests ' +
  '(delivery status) for a broadcast, message or send; evite_get_event / evite_list_events for event changes — ' +
  'and do not resend blindly: a resent broadcast or invitation emails the guests again.';

export interface EviteFetchOptions {
  /**
   * This request changes state (it may be a GET — the duplicate-event copy
   * route creates a draft). A transport failure then throws
   * {@link WriteOutcomeUnknownError} instead of the plain error.
   */
  write?: boolean;
  /**
   * Abort with the MCP call (default `true`). `false` for the single-flight
   * session login: one caller cancelling must not fail the others queued on it.
   * The deadline applies either way.
   */
  cancellable?: boolean;
  /** Deadline in ms; defaults to {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Service name for error messages; defaults to `Evite`. */
  service?: string;
  /** Injectable fetch (tests, `loginWithPassword`); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** `fetch` with a deadline, the MCP call's cancellation, and honest write failures. */
export async function eviteFetch(
  url: string,
  init: RequestInit,
  opts: EviteFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const service = opts.service ?? 'Evite';
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = opts.cancellable === false ? deadline : withAmbientCancellation(deadline);
  const impl = opts.fetchImpl ?? fetch;
  try {
    return await impl(url, { ...init, signal });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    if (opts.write) {
      throw new WriteOutcomeUnknownError(service, init.method ?? 'GET', {
        cause,
        hint: WRITE_OUTCOME_HINT,
        ...(timedOut ? { timeoutMs } : {}),
      });
    }
    if (timedOut) {
      throw new McpToolError(`${service} request timed out after ${timeoutMs}ms`, {
        kind: 'timeout',
        cause,
        hint: 'Evite did not answer in time; this was a read, so it is safe to retry.',
      });
    }
    // A read that never got a response: undici's bare `TypeError('fetch
    // failed')` names neither the host nor the reason. Say both, with a hint
    // keyed to the cause (DNS, TLS, refused, an egress proxy's refusal). Still
    // a plain error — a read is safe to retry.
    throw describeTransportFailure(cause, url, service) ?? cause;
  }
}
