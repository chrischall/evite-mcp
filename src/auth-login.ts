// ────────────────────────────────────────────────────────────────────────────
// Tier-1 email/password login — POST /ajax_login (CAPTURED 2026-06-01)
// ────────────────────────────────────────────────────────────────────────────
//
// Evite's email/password form posts JSON `{ email, password }` to
// `https://www.evite.com/ajax_login` (no CSRF on the login itself). On 200 the
// response sets the session cookies via `Set-Cookie`:
//   x-evite-session, evtsession, csrftoken, x-evite-features
// We collect those four into a `cookie:` header and surface `csrftoken` as the
// CSRF token. The resulting session is identical in shape to what tier-2
// (fetchproxy) produces, so the rest of the client is unchanged.
//
// Set-Cookie reading: Node's fetch exposes `headers.getSetCookie()` (an array,
// one entry per cookie — the correct way to read multiple Set-Cookie headers).
// If a runtime lacks it we fall back to the single joined `set-cookie` header
// (`headers.get('set-cookie')`) and split it. The password is NEVER echoed in
// errors.

import { SessionNotAuthenticatedError } from '@chrischall/mcp-utils';

/** Evite's email/password login endpoint. */
const LOGIN_URL = 'https://www.evite.com/ajax_login';

/** The CSRF cookie name (surfaced separately for write tools). */
const CSRF_COOKIE = 'csrftoken';

/**
 * Session cookies we keep from the login response, in this header order. The
 * first two are the core session pair; the latter two are optional extras.
 */
const KEPT_COOKIES = ['x-evite-session', 'evtsession', CSRF_COOKIE, 'x-evite-features'];

/** At least one of these must come back for the login to count as a session. */
const SESSION_COOKIES = ['x-evite-session', 'evtsession'];

/** The injectable fetch signature (matches the global `fetch`). */
export type FetchImpl = typeof fetch;

/** A resolved session: the `cookie` header plus an optional CSRF token. */
export interface PasswordLoginResult {
  cookieHeader: string;
  csrfToken?: string;
}

/**
 * Throw a "go authenticate" error pointing the user at the credential env vars.
 * The password is never interpolated. We reuse {@link SessionNotAuthenticatedError}
 * (so callers classify it like any other unauthenticated state) but replace its
 * hint with a credential-specific one.
 */
function badCredentials(): never {
  const err = new SessionNotAuthenticatedError('Evite', 'https://www.evite.com');
  // `hint` is declared readonly (compile-time only); override it at runtime with
  // an actionable, value-free message. Never include the password.
  (err as { hint?: string }).hint =
    'Login to Evite failed. Check EVITE_EMAIL / EVITE_PASSWORD, or set EVITE_SESSION_COOKIE / use the fetchproxy browser bridge instead.';
  throw err;
}

/**
 * Read every `Set-Cookie` from a response as raw `name=value; attrs` strings,
 * preferring `getSetCookie()` and falling back to a split of the joined header.
 */
function readSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  // Fallback: a single joined `set-cookie` header. Splitting on commas is
  // imperfect (RFC cookie dates contain commas) but the Evite session cookies
  // carry no comma-bearing attributes, so a split on `, ` between cookie pairs
  // is safe here. We only ever extract the leading `name=value` of each entry.
  const joined = typeof headers.get === 'function' ? headers.get('set-cookie') : null;
  if (!joined) return [];
  return joined.split(/,\s*(?=[^;,\s]+=)/);
}

/**
 * Parse `name=value; attrs` Set-Cookie strings into a `name → value` map for
 * the cookies we care about. Only the leading `name=value` pair is read; cookie
 * attributes (Path, HttpOnly, …) are ignored.
 */
function parseKeptCookies(setCookies: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of setCookies) {
    const firstPair = raw.split(';', 1)[0]?.trim() ?? '';
    const eq = firstPair.indexOf('=');
    if (eq <= 0) continue;
    const name = firstPair.slice(0, eq).trim();
    const value = firstPair.slice(eq + 1).trim();
    if (KEPT_COOKIES.includes(name) && value) out[name] = value;
  }
  return out;
}

/**
 * Tier-1 login: POST `{ email, password }` to `/ajax_login`, then build a
 * session from the response `Set-Cookie` headers. Throws
 * {@link SessionNotAuthenticatedError} on a non-200 or a session-less 200.
 *
 * @param fetchImpl Injectable fetch (defaults to the global `fetch`) — tests
 *   pass a stub so no real network call is made.
 */
export async function loginWithPassword(
  email: string,
  password: string,
  fetchImpl: FetchImpl = fetch,
): Promise<PasswordLoginResult> {
  let response: Response;
  try {
    response = await fetchImpl(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    // Transport failure — treat as "couldn't authenticate" without echoing creds.
    badCredentials();
  }

  if (!response.ok) badCredentials();

  const cookies = parseKeptCookies(readSetCookies(response));
  const hasSession = SESSION_COOKIES.some((name) => Boolean(cookies[name]));
  if (!hasSession) badCredentials();

  // Build the cookie header in declaration order.
  const parts: string[] = [];
  for (const name of KEPT_COOKIES) {
    const value = cookies[name];
    if (value) parts.push(`${name}=${value}`);
  }

  const result: PasswordLoginResult = { cookieHeader: parts.join('; ') };
  const csrfToken = cookies[CSRF_COOKIE];
  if (csrfToken) result.csrfToken = csrfToken;
  return result;
}
