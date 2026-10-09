import { delimiter } from 'node:path';
import { readEnvVar } from '@chrischall/mcp-utils';

/**
 * EVITE_UPLOAD_DIR — optional allow-list of directories `evite_upload_photo`
 * may read from (one or more, split on the platform path delimiter; `~` ok).
 * Undefined when unset or empty: uploads are then unconfined.
 */
function uploadRoots(): string[] | undefined {
  const roots = readEnvVar('EVITE_UPLOAD_DIR')?.split(delimiter).filter(Boolean);
  return roots && roots.length > 0 ? roots : undefined;
}

// Session env vars (EVITE_EMAIL / EVITE_PASSWORD / EVITE_SESSION_COOKIE /
// EVITE_DISABLE_FETCHPROXY) are read only by auth.ts, which takes an injectable
// env for tests; keeping a second accessor here would let the two drift.
export const config = {
  uploadRoots,
};
