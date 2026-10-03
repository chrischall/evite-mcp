import { describe, it, expect, vi } from 'vitest';

import { InvalidCredentialsError, loginWithPassword } from '../src/auth-login.js';
import {
  EdgeBlockedError,
  RateLimitError,
  SessionNotAuthenticatedError,
  UnreachableError,
} from '@chrischall/mcp-utils';

// A minimal `Response`-like stub good enough for loginWithPassword: it needs
// `ok`, `status`, and `headers.getSetCookie()`. We never hit the network — a
// fake fetch is injected.
function fakeResponse(opts: { ok: boolean; status: number; setCookies?: string[] }): Response {
  const setCookies = opts.setCookies ?? [];
  return {
    ok: opts.ok,
    status: opts.status,
    headers: { getSetCookie: () => setCookies },
    json: async () => ({}),
  } as unknown as Response;
}

// loginWithPassword now makes TWO calls: a priming GET (must yield a csrftoken
// cookie) then the login POST. This helper returns the prime cookies on GET and
// the given login response on POST.
function twoPhase(opts: {
  primeCookies?: string[];
  login: { ok: boolean; status: number; setCookies?: string[] };
}) {
  const primeCookies = opts.primeCookies ?? ['csrftoken=prime-csrf; Path=/; Secure'];
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') return fakeResponse(opts.login);
    return fakeResponse({ ok: true, status: 200, setCookies: primeCookies });
  });
}

const SET_COOKIES = [
  'x-evite-session=sess-abc; Path=/; HttpOnly; Secure; SameSite=Lax',
  'evtsession=evt-def; Path=/; HttpOnly',
  'csrftoken=csrf-ghi; Path=/; Secure',
  'x-evite-features=feat-jkl; Path=/',
  // An unrelated cookie that must NOT leak into the cookie header.
  'cf_clearance=should-be-ignored; Path=/; Secure',
];

describe('loginWithPassword', () => {
  it('primes with a GET then POSTs JSON {email,password} to /ajax_login with CSRF + Origin', async () => {
    const fetchImpl = twoPhase({ login: { ok: true, status: 200, setCookies: SET_COOKIES } });

    await loginWithPassword('user@example.com', 'hunter2', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Call 0: the priming GET to the homepage.
    const [primeUrl, primeInit] = fetchImpl.mock.calls[0]!;
    expect(primeUrl).toBe('https://www.evite.com/');
    expect(primeInit?.method ?? 'GET').toBe('GET');
    // Call 1: the login POST, with the CSRF header (matching the primed cookie),
    // the cookie jar, and an Origin header.
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(url).toBe('https://www.evite.com/ajax_login');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type'] ?? headers['content-type']).toContain('application/json');
    expect(headers['X-CSRFToken']).toBe('prime-csrf');
    expect(headers['Origin']).toBe('https://www.evite.com');
    expect(headers['Cookie']).toContain('csrftoken=prime-csrf');
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'user@example.com',
      password: 'hunter2',
    });
  });

  it('parses the login Set-Cookie into a header with exactly the four session cookies', async () => {
    const fetchImpl = twoPhase({ login: { ok: true, status: 200, setCookies: SET_COOKIES } });
    const result = await loginWithPassword('user@example.com', 'pw', fetchImpl);

    expect(result.cookieHeader).toContain('x-evite-session=sess-abc');
    expect(result.cookieHeader).toContain('evtsession=evt-def');
    expect(result.cookieHeader).toContain('csrftoken=csrf-ghi');
    expect(result.cookieHeader).toContain('x-evite-features=feat-jkl');
    expect(result.cookieHeader).not.toContain('cf_clearance');
  });

  it('surfaces the (rotated) login csrftoken as csrfToken', async () => {
    const fetchImpl = twoPhase({ login: { ok: true, status: 200, setCookies: SET_COOKIES } });
    const result = await loginWithPassword('user@example.com', 'pw', fetchImpl);
    expect(result.csrfToken).toBe('csrf-ghi');
  });

  it('resolves on just the core session pair (optional cookies absent)', async () => {
    const fetchImpl = twoPhase({
      login: {
        ok: true,
        status: 200,
        setCookies: ['x-evite-session=s; Path=/', 'evtsession=e; Path=/'],
      },
    });
    const result = await loginWithPassword('user@example.com', 'pw', fetchImpl);
    expect(result.cookieHeader).toBe('x-evite-session=s; evtsession=e');
    expect(result.csrfToken).toBeUndefined();
  });

  it('throws SessionNotAuthenticatedError when the prime yields no csrftoken', async () => {
    // Prime returns no csrftoken → cannot satisfy the CSRF check → bail before POST.
    const fetchImpl = twoPhase({
      primeCookies: ['x-evite-features=f; Path=/'],
      login: { ok: true, status: 200, setCookies: SET_COOKIES },
    });
    await expect(
      loginWithPassword('user@example.com', 'pw', fetchImpl),
    ).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
    // The login POST must never be attempted without a CSRF token.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws SessionNotAuthenticatedError on a 401 (bad creds) without echoing the password', async () => {
    const fetchImpl = twoPhase({ login: { ok: false, status: 401 } });

    let thrown: unknown;
    try {
      await loginWithPassword('user@example.com', 'super-secret-pw', fetchImpl);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SessionNotAuthenticatedError);
    const err = thrown as Error & { hint?: string };
    expect(err.message).not.toContain('super-secret-pw');
    expect(err.hint ?? '').not.toContain('super-secret-pw');
    expect((err.hint ?? '') + err.message).toMatch(/EVITE_EMAIL|EVITE_PASSWORD/);
  });

  it('throws SessionNotAuthenticatedError when a 200 carries no session cookies', async () => {
    const fetchImpl = twoPhase({
      login: { ok: true, status: 200, setCookies: ['cf_clearance=x; Path=/'] },
    });
    await expect(
      loginWithPassword('user@example.com', 'pw', fetchImpl),
    ).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
  });

  it('falls back to the set-cookie header when getSetCookie is unavailable', async () => {
    // Simulate a runtime whose Headers lacks getSetCookie: expose a single joined
    // `set-cookie` header via `.get()` instead. Used for BOTH prime and login.
    const joined = (value: string) =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'set-cookie' ? value : null),
        },
        json: async () => ({}),
      }) as unknown as Response;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === 'POST'
        ? joined('x-evite-session=s; Path=/, evtsession=e; Path=/, csrftoken=c; Path=/')
        : joined('csrftoken=prime; Path=/'),
    );

    const result = await loginWithPassword('user@example.com', 'pw', fetchImpl);
    expect(result.cookieHeader).toContain('x-evite-session=s');
    expect(result.cookieHeader).toContain('evtsession=e');
    expect(result.csrfToken).toBe('c');
  });
});

describe('loginWithPassword — error & parser branches', () => {
  it('maps a priming-GET network failure to SessionNotAuthenticatedError', async () => {
    await expect(loginWithPassword('u@e.com', 'pw', vi.fn(async () => { throw new Error('down'); }))).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
  });
  it('maps a login-POST network failure to SessionNotAuthenticatedError', async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('down');
      return fakeResponse({ ok: true, status: 200, setCookies: ['csrftoken=prime-csrf; Path=/'] });
    });
    await expect(loginWithPassword('u@e.com', 'pw', fetchImpl)).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
  });
  it('reads Set-Cookie via the legacy headers.get fallback', async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, status: 200, headers: { getSetCookie: () => ['x-evite-session=s; Path=/', 'evtsession=e; Path=/'] }, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, headers: { get: (n: string) => (n === 'set-cookie' ? 'csrftoken=prime-csrf; Path=/' : null) }, json: async () => ({}) } as unknown as Response;
    });
    expect((await loginWithPassword('u@e.com', 'pw', fetchImpl)).cookieHeader).toBe('x-evite-session=s; evtsession=e');
  });
  it('skips malformed and empty-value Set-Cookie entries', async () => {
    const fetchImpl = twoPhase({ login: { ok: true, status: 200, setCookies: ['x-evite-session=s', 'evtsession=e', 'malformed-no-eq', 'empty='] } });
    expect((await loginWithPassword('u@e.com', 'pw', fetchImpl)).cookieHeader).toBe('x-evite-session=s; evtsession=e');
  });
  it('treats a null legacy set-cookie header as no cookies (login then fails)', async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
      return fakeResponse({ ok: true, status: 200, setCookies: ['csrftoken=prime-csrf; Path=/'] });
    });
    await expect(loginWithPassword('u@e.com', 'pw', fetchImpl)).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
  });
});

// fleet-audit #100: only a 401 from /ajax_login means the credentials are wrong.
// A 429 or a 5xx is Evite being busy/down — telling the user to "check
// EVITE_EMAIL / EVITE_PASSWORD" for those sends them after the wrong problem.
describe('loginWithPassword — failure classification', () => {
  const postReturning = (res: Response) =>
    vi.fn(async (_u: string | URL | Request, init?: RequestInit) =>
      init?.method === 'POST'
        ? res
        : fakeResponse({ ok: true, status: 200, setCookies: ['csrftoken=prime-csrf; Path=/'] }),
    );

  it('marks a 401 as InvalidCredentialsError (a SessionNotAuthenticatedError naming the env vars)', async () => {
    const err = await loginWithPassword('u@e.com', 'pw', twoPhase({ login: { ok: false, status: 401 } })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect(err).toBeInstanceOf(SessionNotAuthenticatedError);
    expect((err as { hint?: string }).hint).toMatch(/EVITE_EMAIL/);
  });

  it('maps a 429 to RateLimitError (with Retry-After), not a credentials error', async () => {
    const err = await loginWithPassword(
      'u@e.com',
      'pw',
      postReturning(new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).not.toBeInstanceOf(SessionNotAuthenticatedError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(120);
    expect(String((err as Error).message) + String((err as { hint?: string }).hint)).not.toMatch(/EVITE_PASSWORD/);
  });

  it('maps a 429 without a usable Retry-After to a plain RateLimitError', async () => {
    const err = await loginWithPassword('u@e.com', 'pw', postReturning(new Response('', { status: 429 }))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBeUndefined();
  });

  it('keeps any other rejection (e.g. a CSRF 403) a retryable sign-in error, not a cached bad-credentials one', async () => {
    const err = await loginWithPassword('u@e.com', 'pw', postReturning(new Response('', { status: 403 }))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SessionNotAuthenticatedError);
    expect(err).not.toBeInstanceOf(InvalidCredentialsError);
  });

  it('maps a 5xx to UnreachableError, not a credentials error', async () => {
    const err = await loginWithPassword('u@e.com', 'pw', postReturning(new Response('', { status: 503 }))).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnreachableError);
    expect((err as UnreachableError).status).toBe(503);
    expect(err).not.toBeInstanceOf(SessionNotAuthenticatedError);
  });
});

// chrischall/mcp-host#1015: a CDN/WAF refusal page in front of /ajax_login never
// reached Evite, so it says nothing about EVITE_EMAIL / EVITE_PASSWORD. Calling
// it InvalidCredentialsError would be cached as PERMANENT by the session manager
// and the server would refuse to log in again until restarted.
describe('loginWithPassword — edge blocks are not bad credentials', () => {
  const CLOUDFRONT_BLOCK = (status: number) =>
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">' +
    '<HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY>' +
    `<H1>${status} ERROR</H1><H2>The request could not be satisfied.</H2><HR noshade size="1px">` +
    "Request blocked. We can't connect to the server for this app or website at this time." +
    '<BR clear="all"><HR noshade size="1px"><PRE>Generated by cloudfront (CloudFront)\n' +
    'Request ID: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789==</PRE></BODY></HTML>';
  const primeOk = () =>
    new Response('', { status: 200, headers: { 'set-cookie': 'csrftoken=prime-csrf; Path=/' } });
  const postReturning = (res: Response) =>
    vi.fn(async (_u: string | URL | Request, init?: RequestInit) => (init?.method === 'POST' ? res : primeOk()));

  it('a 401 CloudFront block on the login POST is EdgeBlockedError, not InvalidCredentialsError', async () => {
    const err = await loginWithPassword(
      'u@e.com',
      'pw',
      postReturning(new Response(CLOUDFRONT_BLOCK(401), { status: 401 })),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect(err).not.toBeInstanceOf(InvalidCredentialsError);
    expect(err).not.toBeInstanceOf(SessionNotAuthenticatedError);
    expect((err as EdgeBlockedError).vendor).toBe('CloudFront');
    expect((err as Error).message).not.toMatch(/EVITE_PASSWORD/);
  });

  it('a 403 Cloudflare challenge on the login POST is EdgeBlockedError, not "check EVITE_PASSWORD"', async () => {
    const challenge = new Response('<html><head><title>Just a moment...</title></head><body></body></html>', {
      status: 403,
      headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
    });
    const err = await loginWithPassword('u@e.com', 'pw', postReturning(challenge)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect((err as EdgeBlockedError).vendor).toBe('Cloudflare');
  });

  it('a blocked priming GET is EdgeBlockedError (no POST), not a credentials error', async () => {
    const fetchImpl = vi.fn(async () => new Response(CLOUDFRONT_BLOCK(403), { status: 403 }));
    const err = await loginWithPassword('u@e.com', 'pw', fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeBlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('control: Evite\'s own 401 "Invalid Email Address / Password" is still InvalidCredentialsError', async () => {
    const err = await loginWithPassword(
      'u@e.com',
      'pw',
      postReturning(
        new Response('"Invalid Email Address / Password"', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidCredentialsError);
    expect(err).not.toBeInstanceOf(EdgeBlockedError);
  });
});
