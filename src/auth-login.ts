// ────────────────────────────────────────────────────────────────────────────
// Tier-1 email/password login — POST /ajax_login (CAPTURED 2026-06-01)
// ────────────────────────────────────────────────────────────────────────────
//
// Evite's email/password form posts JSON `{ email, password }` to
// `https://www.evite.com/ajax_login`. The endpoint is CSRF-protected (Django):
// a cold POST is rejected with `403 {"error":"HTTP_403"}`. A real login needs
//
//   1. a priming GET to https://www.evite.com/ — sets the `csrftoken` cookie (and
//      anonymous session cookies), then
//   2. the POST carrying that full cookie jar back, the `X-CSRFToken` header
//      (matching the `csrftoken` cookie), and an `Origin: https://www.evite.com`
//      header (Django's HTTPS Origin/Referer CSRF check).
//
// With all three the endpoint returns `401 "Invalid Email Address / Password"`
// for bad creds and, on success, `200` with the authenticated session cookies
// via `Set-Cookie`: x-evite-session, evtsession, csrftoken, x-evite-features.
// We collect those into a `cookie:` header and surface `csrftoken` as the CSRF
// token. The resulting session is identical in shape to what tier-2 (fetchproxy)
// produces, so the rest of the client is unchanged.
//
// (The earlier "no CSRF on login" note was wrong: the original capture came from
// a signed-in browser that already held the `csrftoken` cookie and sent the
// header automatically, which hid the requirement.)
//
// Set-Cookie reading is delegated to the shared mcp-utils `CookieJar`
// (`getSetCookie()` preferred, joined-header split fallback, deletion markers
// dropped). The password is NEVER echoed in errors.

import { CookieJar, SessionNotAuthenticatedError } from '@chrischall/mcp-utils';

/** Evite origin + endpoints. */
const ORIGIN = 'https://www.evite.com';
const HOME_URL = `${ORIGIN}/`;
const LOGIN_URL = `${ORIGIN}/ajax_login`;

/** A realistic UA — some edges reject the default Node fetch agent. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/** The CSRF cookie name (also surfaced separately for write tools). */
const CSRF_COOKIE = 'csrftoken';

/**
 * Session cookies we keep from the login response for the final `cookie:`
 * header, in this order. The first two are the core session pair; the latter
 * two are optional extras.
 */
const KEPT_COOKIES = ['x-evite-session', 'evtsession', CSRF_COOKIE, 'x-evite-features'];

/** At least one of these must come back from the LOGIN response for a session. */
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
 * The password is never interpolated.
 */
function badCredentials(): never {
  const err = new SessionNotAuthenticatedError('Evite', ORIGIN);
  (err as { hint?: string }).hint =
    'Login to Evite failed. Check EVITE_EMAIL / EVITE_PASSWORD, or set EVITE_SESSION_COOKIE / use the fetchproxy browser bridge instead.';
  throw err;
}

/**
 * Project a jar onto the {@link KEPT_COOKIES} keep-list as a `Cookie:` header
 * value, in keep-list declaration order (absent names are skipped). This is the
 * evite-specific slice over the shared jar: the login response sets extras
 * (e.g. `cf_clearance`) that must NOT leak into the session header.
 */
function keptCookieHeader(jar: CookieJar, keep: readonly string[]): string {
  return keep
    .filter((name) => jar.get(name))
    .map((name) => `${name}=${jar.get(name)}`)
    .join('; ');
}

/**
 * Tier-1 login: prime the CSRF cookie with a GET, then POST `{ email, password }`
 * to `/ajax_login` with the jar + `X-CSRFToken` + `Origin`. Builds a session from
 * the login response `Set-Cookie`. Throws {@link SessionNotAuthenticatedError} on
 * a missing CSRF cookie, a non-200, or a session-less 200.
 *
 * @param fetchImpl Injectable fetch (defaults to the global `fetch`) — tests pass
 *   a stub so no real network call is made.
 */
export async function loginWithPassword(
  email: string,
  password: string,
  fetchImpl: FetchImpl = fetch,
): Promise<PasswordLoginResult> {
  // ── 1. Prime: GET the homepage to obtain the csrftoken (+ anonymous) cookies.
  // The WHOLE priming jar is echoed back on the POST (the CSRF check requires it).
  const primed = new CookieJar();
  try {
    const prime = await fetchImpl(HOME_URL, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
    });
    primed.absorb(prime.headers);
  } catch {
    badCredentials();
  }
  const csrf = primed.get(CSRF_COOKIE);
  if (!csrf) badCredentials(); // can't satisfy the CSRF check without it

  // ── 2. Login: POST creds with the full jar, the CSRF header, and Origin.
  let response: Response;
  try {
    response = await fetchImpl(LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': csrf,
        Cookie: primed.header(),
        Origin: ORIGIN,
        Referer: HOME_URL,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    badCredentials();
  }

  if (!response.ok) badCredentials();

  // ── 3. Build the authenticated session from the LOGIN response's Set-Cookie
  // (Evite re-sets the full authenticated jar on success — session pair, rotated
  // csrftoken, features). The prime jar existed only to pass the CSRF check.
  const loginJar = new CookieJar();
  loginJar.absorb(response.headers);
  const hasSession = SESSION_COOKIES.some((name) => Boolean(loginJar.get(name)));
  if (!hasSession) badCredentials();

  const result: PasswordLoginResult = { cookieHeader: keptCookieHeader(loginJar, KEPT_COOKIES) };
  const csrfToken = loginJar.get(CSRF_COOKIE);
  if (csrfToken) result.csrfToken = csrfToken;
  return result;
}
