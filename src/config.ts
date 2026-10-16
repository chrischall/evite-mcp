import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { readEnvVar } from '@chrischall/mcp-utils';

/** Where `evite_upload_photo` may read from when EVITE_UPLOAD_DIR is unset. */
export const DEFAULT_UPLOAD_DIR = join(homedir(), 'Downloads', 'evite-mcp');

/**
 * EVITE_UPLOAD_DIR — the directories `evite_upload_photo` may read from (one or
 * more, split on the platform path delimiter; `~` ok). Unset or empty, uploads
 * are confined to {@link DEFAULT_UPLOAD_DIR} — never unconfined (fleet-audit
 * #1243): guest-authored text reaches the model, and an unconfined default let
 * any readable image on the machine be pushed to a guest-visible gallery.
 */
function uploadRoots(): string[] {
  const roots = readEnvVar('EVITE_UPLOAD_DIR')?.split(delimiter).filter(Boolean);
  return roots && roots.length > 0 ? roots : [DEFAULT_UPLOAD_DIR];
}

// Session env vars (EVITE_EMAIL / EVITE_PASSWORD / EVITE_SESSION_COOKIE /
// EVITE_DISABLE_FETCHPROXY) are read only by auth.ts, which takes an injectable
// env for tests; keeping a second accessor here would let the two drift.
export const config = {
  uploadRoots,
};
