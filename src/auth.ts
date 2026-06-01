// ────────────────────────────────────────────────────────────────────────────
// Session resolution — Pattern A (browser-bootstrap + Node-direct)
// ────────────────────────────────────────────────────────────────────────────
//
// Evite has no public API. This MCP talks to the site's internal `/services/`
// layer using the session cookies a signed-in browser holds. `resolveSession()`
// produces the `cookie` header those calls need, in priority order:
//
//   1. EVITE_SESSION_COOKIE (raw cookie header)
//      A pre-baked `cookie:` header string the user pasted from their browser
//      (or set in CI). Used verbatim — no bootstrap, no parsing. The escape
//      hatch for headless environments where the browser bridge can't apply.
//
//   2. fetchproxy fallback
//      Lift the session out of the user's already-signed-in evite.com tab.
//      `@fetchproxy/bootstrap` opens a one-shot WebSocket bridge, reads the
//      declared cookies (x-evite-session / evtsession / x-evite-features /
//      csrftoken — the declared key list IS the security boundary), and closes
//      the bridge. Every subsequent Evite call goes out via plain Node `fetch()`
//      with these cookies attached — fetchproxy is NOT in the request hot path.
//
//      Opt out with EVITE_DISABLE_FETCHPROXY=1 (headless CI).
//
//   3. Error
//      Nothing to authenticate with → SessionNotAuthenticatedError with an
//      actionable hint naming both escape hatches.
//
// DEFERRED (#2): tier-1 email/password form login. It would slot in as a path
// between (1) and (2) — capture the login POST, hydrate the same cookies — so
// the resolver shape here is intentionally path-ordered to accommodate it.
//
// Testability: `@fetchproxy/bootstrap` is mocked at the module boundary in
// tests/auth.test.ts. No other test imports `bootstrap`.

import { bootstrap } from '@fetchproxy/bootstrap';
import { readEnvVar, parseBoolEnv, SessionNotAuthenticatedError } from '@chrischall/mcp-utils';

/** Server identity reported to the fetchproxy bridge. */
const SERVER_NAME = 'evite-mcp';
const SERVER_VERSION = '0.1.0'; // x-release-please-version

/** The cookie name carrying the CSRF token (needed for writes, Plan 3). */
const CSRF_COOKIE = 'csrftoken';

/**
 * Cookies the MCP declares to the fetchproxy bridge. The first two are the
 * session pair; the latter two are optional extras Evite's frontend sends.
 * The declared key list is the security boundary — we never read undeclared
 * cookies.
 */
const DECLARED_COOKIES = ['x-evite-session', 'evtsession', 'x-evite-features', CSRF_COOKIE];

/** Cookies that must be present (either one) for a session to count as valid. */
const SESSION_COOKIES = ['x-evite-session', 'evtsession'];

/** A resolved Evite session: the `cookie` header plus an optional CSRF token. */
export interface ResolvedSession {
  /** The full `cookie:` request-header value for authenticated calls. */
  cookieHeader: string;
  /** The CSRF token, when present — used by write tools (Plan 3). */
  csrfToken?: string;
}

/** Options for {@link resolveSession} (reserved for future paths, e.g. login). */
export interface ResolveSessionOptions {
  /** Override the env source (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

function fetchproxyDisabled(env?: NodeJS.ProcessEnv): boolean {
  return parseBoolEnv('EVITE_DISABLE_FETCHPROXY', { default: false, env });
}

function notAuthed(): never {
  throw new SessionNotAuthenticatedError('Evite', 'https://www.evite.com');
}

/**
 * Resolve an Evite session into a `cookie` header (+ optional CSRF token),
 * following the priority order documented at the top of this file. Throws
 * {@link SessionNotAuthenticatedError} when no path yields a session.
 */
export async function resolveSession(opts: ResolveSessionOptions = {}): Promise<ResolvedSession> {
  const env = opts.env;

  // ── Path 1: raw cookie header from the environment.
  const rawCookie = readEnvVar('EVITE_SESSION_COOKIE', { env });
  if (rawCookie) {
    return { cookieHeader: rawCookie };
  }

  // ── Path 2: fetchproxy fallback.
  if (!fetchproxyDisabled(env)) {
    let session: { cookies?: Record<string, string> };
    try {
      session = await bootstrap({
        serverName: SERVER_NAME,
        version: SERVER_VERSION,
        domains: ['evite.com'],
        declare: {
          cookies: [...DECLARED_COOKIES],
          localStorage: [],
          sessionStorage: [],
          captureHeaders: [],
        },
      });
    } catch {
      // Bridge offline / user not signed in / declined — all surface as the
      // same "go sign in" condition. We deliberately do not echo the bridge
      // error (it may carry environment detail).
      notAuthed();
    }

    const cookies = session.cookies ?? {};
    const hasSession = SESSION_COOKIES.some((name) => Boolean(cookies[name]));
    if (!hasSession) notAuthed();

    // Build the cookie header from declared cookies that came back, preserving
    // declaration order. CSRF is surfaced separately for write tools.
    const parts: string[] = [];
    for (const name of DECLARED_COOKIES) {
      const value = cookies[name];
      if (value) parts.push(`${name}=${value}`);
    }
    const csrfToken = cookies[CSRF_COOKIE];

    const resolved: ResolvedSession = { cookieHeader: parts.join('; ') };
    if (csrfToken) resolved.csrfToken = csrfToken;
    return resolved;
  }

  // ── Path 3: nothing configured and fetchproxy explicitly disabled.
  notAuthed();
}
