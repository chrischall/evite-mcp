import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { delimiter } from 'node:path';
import { config } from '../src/config.js';

// config.ts holds only the upload allow-list; the session env vars are read by auth.ts.
const KEYS = ['EVITE_UPLOAD_DIR'] as const;

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

  it('uploadRoots splits EVITE_UPLOAD_DIR on the path delimiter; unset/empty means no confinement', () => {
    expect(config.uploadRoots()).toBeUndefined();
    process.env.EVITE_UPLOAD_DIR = delimiter;
    expect(config.uploadRoots()).toBeUndefined();
    process.env.EVITE_UPLOAD_DIR = `~/Pictures${delimiter}/tmp/evite${delimiter}`;
    expect(config.uploadRoots()).toEqual(['~/Pictures', '/tmp/evite']);
  });
});
