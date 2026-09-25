import { delimiter } from 'node:path';
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';

/**
 * EVITE_UPLOAD_DIR — optional allow-list of directories `evite_upload_photo`
 * may read from (one or more, split on the platform path delimiter; `~` ok).
 * Undefined when unset or empty: uploads are then unconfined.
 */
function uploadRoots(): string[] | undefined {
  const roots = readEnvVar('EVITE_UPLOAD_DIR')?.split(delimiter).filter(Boolean);
  return roots && roots.length > 0 ? roots : undefined;
}

export const config = {
  email: () => readEnvVar('EVITE_EMAIL'),
  password: () => readEnvVar('EVITE_PASSWORD'),
  disableFetchproxy: () => parseBoolEnv('EVITE_DISABLE_FETCHPROXY', { default: false }),
  uploadRoots,
};
