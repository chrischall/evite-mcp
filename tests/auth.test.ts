import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resolveSession() drives two paths in Plan 2:
//   1. EVITE_SESSION_COOKIE → raw cookie header, used verbatim (no bootstrap).
//   2. fetchproxy fallback → @fetchproxy/bootstrap reads the session cookies
//      (x-evite-session / evtsession / x-evite-features / csrftoken) from the
//      user's signed-in evite.com tab and builds the cookie header.
//   3. error: SessionNotAuthenticatedError when neither yields a session.
//
// Deferred to #2: tier-1 email/password form login. The resolver is shaped so
// it can slot in as a path between env-cookie and fetchproxy later.
//
// Mock @fetchproxy/bootstrap at the module boundary — never hit a real WS.
const bootstrapMock = vi.fn();
vi.mock('@fetchproxy/bootstrap', () => ({
  bootstrap: (...args: unknown[]) => bootstrapMock(...args),
}));

import { resolveSession } from '../src/auth.js';
import { SessionNotAuthenticatedError } from '@chrischall/mcp-utils';

const ENV_KEYS = ['EVITE_SESSION_COOKIE', 'EVITE_DISABLE_FETCHPROXY'] as const;

describe('resolveSession', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    bootstrapMock.mockReset();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('path 1: EVITE_SESSION_COOKIE', () => {
    it('uses the raw cookie header verbatim and does not call bootstrap', async () => {
      process.env.EVITE_SESSION_COOKIE = 'x-evite-session=s; evtsession=e';
      const result = await resolveSession();
      expect(result.cookieHeader).toBe('x-evite-session=s; evtsession=e');
      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it('takes precedence even when fetchproxy would otherwise run', async () => {
      process.env.EVITE_SESSION_COOKIE = 'x-evite-session=s';
      bootstrapMock.mockResolvedValue({ cookies: { 'x-evite-session': 'nope' } });
      const result = await resolveSession();
      expect(result.cookieHeader).toBe('x-evite-session=s');
      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it('treats a blank/sanitized env value as unset (falls through to fetchproxy)', async () => {
      process.env.EVITE_SESSION_COOKIE = '   ';
      bootstrapMock.mockResolvedValue({
        cookies: { 'x-evite-session': 's', evtsession: 'e' },
      });
      const result = await resolveSession();
      expect(bootstrapMock).toHaveBeenCalledTimes(1);
      expect(result.cookieHeader).toContain('x-evite-session=s');
    });
  });

  describe('path 2: fetchproxy fallback', () => {
    it('calls bootstrap with the declared evite cookies and builds the cookie header', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: {
          'x-evite-session': 's',
          evtsession: 'e',
          'x-evite-features': 'f',
          csrftoken: 'c',
        },
      });

      const result = await resolveSession();

      expect(bootstrapMock).toHaveBeenCalledTimes(1);
      const opts = bootstrapMock.mock.calls[0]![0] as {
        serverName: string;
        version: string;
        domains: string[];
        declare: {
          cookies: string[];
          localStorage: string[];
          sessionStorage: string[];
          captureHeaders: unknown[];
        };
      };
      expect(opts.serverName).toBe('evite-mcp');
      expect(typeof opts.version).toBe('string');
      expect(opts.domains).toEqual(['evite.com']);
      // Copy before sorting — the declared array is shared module state in the
      // implementation; mutating it here would reorder the live cookie list.
      expect([...opts.declare.cookies].sort()).toEqual(
        ['csrftoken', 'evtsession', 'x-evite-features', 'x-evite-session'],
      );
      expect(opts.declare.localStorage).toEqual([]);
      expect(opts.declare.sessionStorage).toEqual([]);
      expect(opts.declare.captureHeaders).toEqual([]);

      expect(result.cookieHeader).toContain('x-evite-session=s');
      expect(result.cookieHeader).toContain('evtsession=e');
      expect(result.cookieHeader).toContain('x-evite-features=f');
      expect(result.csrfToken).toBe('c');
    });

    it('omits absent optional cookies but still resolves on the core session pair', async () => {
      bootstrapMock.mockResolvedValue({
        cookies: { 'x-evite-session': 's', evtsession: 'e' },
      });
      const result = await resolveSession();
      expect(result.cookieHeader).toBe('x-evite-session=s; evtsession=e');
      expect(result.csrfToken).toBeUndefined();
    });

    it('throws SessionNotAuthenticatedError when bootstrap returns no session cookies', async () => {
      bootstrapMock.mockResolvedValue({ cookies: {} });
      await expect(resolveSession()).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
    });

    it('throws SessionNotAuthenticatedError when bootstrap itself fails', async () => {
      bootstrapMock.mockRejectedValue(new Error('extension offline'));
      await expect(resolveSession()).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
    });
  });

  describe('path 3: nothing configured', () => {
    it('throws SessionNotAuthenticatedError when EVITE_DISABLE_FETCHPROXY=1 and no cookie env', async () => {
      process.env.EVITE_DISABLE_FETCHPROXY = '1';
      await expect(resolveSession()).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it('honors EVITE_DISABLE_FETCHPROXY=1 but still accepts the cookie env', async () => {
      process.env.EVITE_DISABLE_FETCHPROXY = '1';
      process.env.EVITE_SESSION_COOKIE = 'x-evite-session=s';
      const result = await resolveSession();
      expect(result.cookieHeader).toBe('x-evite-session=s');
      expect(bootstrapMock).not.toHaveBeenCalled();
    });

    it.each(['0', 'false', '', 'off'])(
      'treats EVITE_DISABLE_FETCHPROXY=%j as enabled (default) so bootstrap runs',
      async (val) => {
        process.env.EVITE_DISABLE_FETCHPROXY = val;
        bootstrapMock.mockResolvedValue({ cookies: { 'x-evite-session': 's', evtsession: 'e' } });
        await resolveSession();
        expect(bootstrapMock).toHaveBeenCalled();
      },
    );
  });
});
