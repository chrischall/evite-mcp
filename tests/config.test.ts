import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { delimiter } from 'node:path';
import { config } from '../src/config.js';

// config.ts holds the env accessors the deferred tier-1 form login (#2) will
// consume (EVITE_EMAIL / EVITE_PASSWORD) plus the fetchproxy opt-out flag that
// auth.ts reads directly. These tests pin the accessor behavior so the #2 work
// has a stable, tested contract to build on.
const KEYS = ['EVITE_EMAIL', 'EVITE_PASSWORD', 'EVITE_DISABLE_FETCHPROXY', 'EVITE_UPLOAD_DIR'] as const;

describe('config', () => {
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reads EVITE_EMAIL / EVITE_PASSWORD when set, undefined otherwise', () => {
    expect(config.email()).toBeUndefined();
    expect(config.password()).toBeUndefined();
    process.env.EVITE_EMAIL = 'me@x.com';
    process.env.EVITE_PASSWORD = 'pw';
    expect(config.email()).toBe('me@x.com');
    expect(config.password()).toBe('pw');
  });

  it('disableFetchproxy defaults to false and honors a truthy flag', () => {
    expect(config.disableFetchproxy()).toBe(false);
    process.env.EVITE_DISABLE_FETCHPROXY = '1';
    expect(config.disableFetchproxy()).toBe(true);
  });

  it('uploadRoots splits EVITE_UPLOAD_DIR on the path delimiter; unset/empty means no confinement', () => {
    expect(config.uploadRoots()).toBeUndefined();
    process.env.EVITE_UPLOAD_DIR = delimiter;
    expect(config.uploadRoots()).toBeUndefined();
    process.env.EVITE_UPLOAD_DIR = `~/Pictures${delimiter}/tmp/evite${delimiter}`;
    expect(config.uploadRoots()).toEqual(['~/Pictures', '/tmp/evite']);
  });
});
