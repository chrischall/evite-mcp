// Invariant: every `// x-release-please-version` annotation in src/ must hold a
// version string that matches package.json's `version`. The walk/compare logic
// lives in `@chrischall/mcp-utils/test`'s `versionSyncTest`; this wraps it in a
// vitest assertion so the release-please drift guard runs in CI.
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionSyncTest } from '@chrischall/mcp-utils/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('version sync', () => {
  it('every `x-release-please-version` annotation matches package.json', () => {
    const mismatches = versionSyncTest({
      srcDir: join(ROOT, 'src'),
      pkgPath: join(ROOT, 'package.json'),
    });
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});
