import {
  createFileStatePersistence,
  resolveStateFile,
  type PersistedCookieSession,
  type SyncStatePersistence,
} from '@chrischall/mcp-utils/session';
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';
import type { ResolvedSession } from './auth.js';

/** Where the resolved session is cached between runs. */
export function sessionCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateFile({
    env,
    envVar: 'EVITE_SESSION_FILE',
    subdir: '.evite-mcp',
    fileName: 'session.json',
  });
}

/** Guard the stored envelope: a usable cookie header, and a login time. */
function isStored(raw: unknown): raw is PersistedCookieSession<ResolvedSession> {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Partial<PersistedCookieSession<ResolvedSession>>;
  if (typeof r.sessionAt !== 'number') return false;
  const s = r.session as Partial<ResolvedSession> | undefined;
  if (s === null || typeof s !== 'object') return false;
  // An empty header is not a session — restoring one would look authenticated
  // and then 401 every request until the expiry heuristic caught it.
  if (typeof s.cookieHeader !== 'string' || s.cookieHeader === '') return false;
  return s.csrfToken === undefined || typeof s.csrfToken === 'string';
}

/**
 * What a cached record is bound to, or `null` when this configuration has
 * nothing worth caching.
 *
 * `resolveSession` has three tiers, and what a resolve COSTS differs by tier:
 *
 *  - **email + password** — a real form login against `/ajax_login`. Worth
 *    caching.
 *  - **`EVITE_SESSION_COOKIE`** — the cookie IS the credential. There is no
 *    resolve to skip, so caching would only copy it onto disk.
 *  - **fetchproxy** — the session is lifted from a signed-in browser tab. Worth
 *    caching most of all: a cached session lets a cold start proceed with no
 *    browser present, which is the difference between working and not on a host
 *    that has none.
 *
 * The tier is part of the binding, so a session resolved one way is never read
 * back by another.
 */
function bindingFor(env: NodeJS.ProcessEnv | undefined): string | null {
  const email = readEnvVar('EVITE_EMAIL', { env });
  const password = readEnvVar('EVITE_PASSWORD', { env });
  if (email && password) {
    return ['password', email.trim().toLowerCase(), password].join('\u0000');
  }
  // Nothing else is worth caching, for two different reasons.
  //
  // A raw EVITE_SESSION_COOKIE is itself the credential — there is no resolve to
  // skip, and caching it would only copy it onto a second place on disk.
  //
  // The fetchproxy tier is the harder call, and this reverses what the original
  // PR claimed for it. It would benefit MOST: the session is lifted from a
  // signed-in browser tab, so a cached one lets a cold start proceed with no
  // browser at all. But there is nothing to bind a record to — that tier runs
  // precisely when no credentials are configured, and the identity lives in the
  // browser. The only available key is a static 'fetchproxy', under which
  // signing into a DIFFERENT Evite account in that tab restores the previous
  // account's session and the server then acts as someone else: reading their
  // events, and writing as them. A browser round-trip is the cheaper mistake.
  //
  // Doing it safely needs an identity check on restore, which the synchronous
  // load() path cannot make. Same resolution as infinitecampus-mcp, where the
  // same static binding was found.
  return null;
}

/**
 * The session cache, or `null` when it is off or the configuration has nothing
 * worth caching (see {@link bindingFor}).
 *
 * Only a salted digest of the credentials is written, never the values.
 */
export function createSessionCache(
  env: NodeJS.ProcessEnv = process.env,
): SyncStatePersistence<PersistedCookieSession<ResolvedSession>> | null {
  if (!parseBoolEnv('EVITE_SESSION_CACHE', { env, default: true })) return null;
  const boundTo = bindingFor(env);
  if (boundTo === null) return null;

  return createFileStatePersistence<PersistedCookieSession<ResolvedSession>>({
    filePath: sessionCachePath(env),
    boundTo,
    validate: (raw) => (isStored(raw) ? raw : null),
  });
}

/**
 * Report a cache write that failed. Not fatal: the session is re-resolvable from
 * whatever tier produced it, so a lost write costs the next start a resolve
 * rather than access. Worth saying, though — a read-only data dir otherwise
 * looks exactly like a server that never caches.
 *
 * stderr only; stdout is the JSON-RPC channel.
 */
export function reportCacheWriteFailure(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    `[evite-mcp] could not cache the session (${detail}); continuing without the ` +
      'cache — every restart will resolve a new session until this is fixed.',
  );
}
