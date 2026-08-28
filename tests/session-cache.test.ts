import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sessionCachePath,
  createSessionCache,
  reportCacheWriteFailure,
} from '../src/session-cache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evite-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Password tier: the one with a real login to skip. */
const pw = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MCP_DATA_DIR: dir,
  EVITE_EMAIL: 'host@example.com',
  EVITE_PASSWORD: 'pw1',
  EVITE_SESSION_CACHE: 'true',
  ...over,
});

const record = (over: Partial<{ cookieHeader: string; csrfToken: string }> = {}) => ({
  session: { cookieHeader: 'sessionid=abc', csrfToken: 'tok', ...over },
  sessionAt: Date.now(),
});

const cacheFile = (d: string): string => join(d, '.evite-mcp', 'session.json');

describe('sessionCachePath', () => {
  it('prefers MCP_DATA_DIR, the variable mcp-host injects', () => {
    expect(sessionCachePath({ MCP_DATA_DIR: '/data' })).toBe('/data/.evite-mcp/session.json');
  });

  it('honours an explicit EVITE_SESSION_FILE', () => {
    expect(sessionCachePath({ EVITE_SESSION_FILE: '/tmp/x.json', MCP_DATA_DIR: '/data' })).toBe(
      '/tmp/x.json',
    );
  });

  it('ignores a sentinel override rather than making a relative ./null', () => {
    expect(sessionCachePath({ EVITE_SESSION_FILE: 'null', HOME: '/home/u' })).toBe(
      '/home/u/.evite-mcp/session.json',
    );
  });
});

describe('which resolve tiers are worth caching', () => {
  it('caches the password tier — a real form login', () => {
    expect(createSessionCache(pw())).not.toBeNull();
  });

  it('does NOT cache the fetchproxy tier — there is no identity to bind a record to', () => {
    // It would benefit most: that tier cannot re-login unaided, so a cached
    // session is what lets a cold start proceed with no browser. But the tier
    // runs precisely when no credentials are set and the identity lives in the
    // browser, so the only available key is a static 'fetchproxy' — under which
    // signing into a DIFFERENT Evite account restores the previous account's
    // session and the server acts as someone else. A browser round-trip is the
    // cheaper mistake.
    expect(createSessionCache({ MCP_DATA_DIR: dir, EVITE_SESSION_CACHE: 'true' })).toBeNull();
  });

  it('does NOT cache a raw EVITE_SESSION_COOKIE — the cookie IS the credential', () => {
    // There is no resolve to skip; caching would only copy it onto disk.
    expect(
      createSessionCache({
        MCP_DATA_DIR: dir,
        EVITE_SESSION_CACHE: 'true',
        EVITE_SESSION_COOKIE: 'sessionid=supplied',
      }),
    ).toBeNull();
  });

  it('does NOT cache when fetchproxy is disabled and nothing else is set', () => {
    expect(
      createSessionCache({
        MCP_DATA_DIR: dir,
        EVITE_SESSION_CACHE: 'true',
        EVITE_DISABLE_FETCHPROXY: '1',
      }),
    ).toBeNull();
  });

  it('prefers the password tier when a supplied cookie is also set', () => {
    // resolveSession checks the pair first, so the binding must match the tier
    // that will actually run — otherwise rotating the password would not
    // discard a record bound to an unchanged cookie.
    expect(createSessionCache(pw({ EVITE_SESSION_COOKIE: 'sessionid=x' }))).not.toBeNull();
  });

  it('is disabled by EVITE_SESSION_CACHE=false, and writes nothing', () => {
    expect(createSessionCache(pw({ EVITE_SESSION_CACHE: 'false' }))).toBeNull();
    expect(existsSync(join(dir, '.evite-mcp'))).toBe(false);
  });
});

describe('credential binding', () => {
  it('round-trips a session through a 0600 file', () => {
    createSessionCache(pw())!.save(record());
    expect(statSync(cacheFile(dir)).mode & 0o777).toBe(0o600);
    const back = createSessionCache(pw())!.load();
    expect(back?.session.cookieHeader).toBe('sessionid=abc');
    expect(back?.session.csrfToken).toBe('tok');
  });

  it.each([
    ['a rotated password', pw({ EVITE_PASSWORD: 'pw2' })],
    ['a different account', pw({ EVITE_EMAIL: 'other@example.com' })],
  ])('discards the cache on %s', (_label, env) => {
    createSessionCache(pw())!.save(record());
    expect(createSessionCache(env)!.load()).toBeNull();
  });

  it('leaves a password-resolved record unread on the fetchproxy tier', () => {
    // Belt and braces: the tier declines a cache outright, so it cannot reach
    // another tier's record even though the file is sitting right there.
    createSessionCache(pw())!.save(record());
    expect(existsSync(cacheFile(dir))).toBe(true);
    expect(createSessionCache({ MCP_DATA_DIR: dir, EVITE_SESSION_CACHE: 'true' })).toBeNull();
  });

  it('matches the email case-insensitively', () => {
    createSessionCache(pw())!.save(record());
    expect(createSessionCache(pw({ EVITE_EMAIL: '  Host@Example.COM ' }))!.load()).not.toBeNull();
  });

  it('writes no credential material to disk', () => {
    createSessionCache(pw())!.save(record());
    const body = readFileSync(cacheFile(dir), 'utf8');
    expect(body).not.toContain('pw1');
    expect(body).not.toContain('host@example.com');
  });
});

describe('stored-record shape guard', () => {
  it.each([
    ['null', null],
    ['a primitive', 'nope'],
    ['a missing sessionAt', { session: { cookieHeader: 'a=1' } }],
    ['a primitive session', { session: 'nope', sessionAt: 1 }],
    ['a missing cookieHeader', { session: {}, sessionAt: 1 }],
    ['an EMPTY cookieHeader', { session: { cookieHeader: '' }, sessionAt: 1 }],
    ['a non-string csrfToken', { session: { cookieHeader: 'a=1', csrfToken: 7 }, sessionAt: 1 }],
  ])('rejects %s rather than restoring an unusable session', (_label, body) => {
    // The empty case matters most: it would look authenticated and then 401
    // every request until the expiry heuristic caught it.
    const p = createSessionCache(pw())!;
    p.save(record());
    // Swap only the STATE, keeping the envelope's salted binding intact —
    // overwriting the whole file would be rejected by the binding check before
    // the shape guard ever ran, which is the wrong reason to pass.
    const envelope = JSON.parse(readFileSync(cacheFile(dir), 'utf8')) as { state: unknown };
    envelope.state = body;
    writeFileSync(cacheFile(dir), JSON.stringify(envelope), { mode: 0o600 });
    expect(createSessionCache(pw())!.load()).toBeNull();
  });

  it('accepts a session with no csrfToken', () => {
    const p = createSessionCache(pw())!;
    p.save({ session: { cookieHeader: 'sessionid=abc' }, sessionAt: Date.now() });
    expect(p.load()?.session.cookieHeader).toBe('sessionid=abc');
  });
});

describe('reportCacheWriteFailure', () => {
  it.each([
    ['an Error', new Error('EROFS'), 'EROFS'],
    ['a non-Error', 'disk gone', 'disk gone'],
  ])('names the cause for %s and stays on stderr', (_label, thrown, expected) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      reportCacheWriteFailure(thrown);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(expected as string));
      // stdout is the JSON-RPC channel; a stray write there corrupts the stream.
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
