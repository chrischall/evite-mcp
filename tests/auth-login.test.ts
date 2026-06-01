import { describe, it, expect, vi } from 'vitest';

import { loginWithPassword } from '../src/auth-login.js';
import { SessionNotAuthenticatedError } from '@chrischall/mcp-utils';

// A minimal `Response`-like stub good enough for loginWithPassword: it needs
// `ok`, `status`, and `headers.getSetCookie()`. We never hit the network — a
// fake fetch is injected.
function fakeResponse(opts: {
  ok: boolean;
  status: number;
  setCookies?: string[];
  json?: unknown;
}): Response {
  const setCookies = opts.setCookies ?? [];
  return {
    ok: opts.ok,
    status: opts.status,
    headers: {
      getSetCookie: () => setCookies,
    },
    json: async () => opts.json ?? {},
  } as unknown as Response;
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
  it('POSTs JSON {email,password} to https://www.evite.com/ajax_login', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ ok: true, status: 200, setCookies: SET_COOKIES }),
    );

    await loginWithPassword('user@example.com', 'hunter2', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://www.evite.com/ajax_login');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type'] ?? headers['content-type']).toContain('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'user@example.com',
      password: 'hunter2',
    });
  });

  it('parses Set-Cookie into a cookie header with exactly the four session cookies', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ ok: true, status: 200, setCookies: SET_COOKIES }),
    );

    const result = await loginWithPassword('user@example.com', 'pw', fetchImpl);

    expect(result.cookieHeader).toContain('x-evite-session=sess-abc');
    expect(result.cookieHeader).toContain('evtsession=evt-def');
    expect(result.cookieHeader).toContain('csrftoken=csrf-ghi');
    expect(result.cookieHeader).toContain('x-evite-features=feat-jkl');
    // The unrelated cookie is dropped.
    expect(result.cookieHeader).not.toContain('cf_clearance');
  });

  it('surfaces the csrftoken as csrfToken', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ ok: true, status: 200, setCookies: SET_COOKIES }),
    );
    const result = await loginWithPassword('user@example.com', 'pw', fetchImpl);
    expect(result.csrfToken).toBe('csrf-ghi');
  });

  it('resolves on just the core session pair (optional cookies absent)', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        ok: true,
        status: 200,
        setCookies: ['x-evite-session=s; Path=/', 'evtsession=e; Path=/'],
      }),
    );
    const result = await loginWithPassword('user@example.com', 'pw', fetchImpl);
    expect(result.cookieHeader).toBe('x-evite-session=s; evtsession=e');
    expect(result.csrfToken).toBeUndefined();
  });

  it('throws SessionNotAuthenticatedError on a 401 (bad creds) without echoing the password', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 401 }));

    let thrown: unknown;
    try {
      await loginWithPassword('user@example.com', 'super-secret-pw', fetchImpl);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SessionNotAuthenticatedError);
    // The password must never appear in the error message or hint.
    const err = thrown as Error & { hint?: string };
    expect(err.message).not.toContain('super-secret-pw');
    expect(err.hint ?? '').not.toContain('super-secret-pw');
    // The hint points the user at the credential env vars.
    expect((err.hint ?? '') + err.message).toMatch(/EVITE_EMAIL|EVITE_PASSWORD/);
  });

  it('throws SessionNotAuthenticatedError when a 200 carries no session cookies', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ ok: true, status: 200, setCookies: ['cf_clearance=x; Path=/'] }),
    );
    await expect(
      loginWithPassword('user@example.com', 'pw', fetchImpl),
    ).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
  });

  it('falls back to the set-cookie header when getSetCookie is unavailable', async () => {
    // Simulate a runtime whose Headers lacks getSetCookie: expose a single
    // joined `set-cookie` header via `.get()` instead.
    const response = {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'set-cookie'
            ? 'x-evite-session=s; Path=/, evtsession=e; Path=/, csrftoken=c; Path=/'
            : null,
      },
      json: async () => ({}),
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => response);

    const result = await loginWithPassword('user@example.com', 'pw', fetchImpl);
    expect(result.cookieHeader).toContain('x-evite-session=s');
    expect(result.cookieHeader).toContain('evtsession=e');
    expect(result.csrfToken).toBe('c');
  });
});
