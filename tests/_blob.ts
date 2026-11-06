import { vi } from 'vitest';

/**
 * A fake mcp-host blob store behind a stubbed `fetch`. The real
 * `blobStoreFromEnv()` client signs the URLs; this answers them from a Map, so
 * the code under test runs the library's own GET/DELETE path end to end
 * without a network. Anything that is not a blob-store URL fails loudly.
 */
export const BLOB_BASE = 'https://blobs.example.test/b/reg-test';
const PATH_PREFIX = '/b/reg-test/';

export interface FakeBlobStore {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  calls: Array<{ method: string; key: string }>;
  put(key: string, bytes: Uint8Array, contentType: string): void;
  failDeletes(): void;
  spy: ReturnType<typeof vi.spyOn>;
}

/** Set the hosted blob env and stub `fetch` with an in-memory store. */
export function useFakeBlobStore(): FakeBlobStore {
  process.env.MCP_BLOB_BASE_URL = BLOB_BASE;
  process.env.MCP_BLOB_SIGNING_KEY = 'test-signing-key';
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const calls: Array<{ method: string; key: string }> = [];
  let deleteFails = false;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.href.startsWith(`${BLOB_BASE}/`)) throw new Error(`unexpected fetch: ${url.href}`);
    const key = decodeURIComponent(url.pathname.slice(PATH_PREFIX.length));
    const method = init?.method ?? 'GET';
    calls.push({ method, key });
    if (method === 'GET') {
      const obj = objects.get(key);
      if (!obj) return new Response('not found', { status: 404 });
      return new Response(obj.bytes, { status: 200, headers: { 'content-type': obj.contentType } });
    }
    if (method === 'DELETE') {
      if (deleteFails) return new Response('boom', { status: 500 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected blob method: ${method}`);
  });
  return {
    objects,
    calls,
    put: (key, bytes, contentType) => objects.set(key, { bytes, contentType }),
    failDeletes: () => {
      deleteFails = true;
    },
    spy,
  };
}

/** A blob key in the exact shape `mintUploadSlot` produces. */
export function uploadKey(filename: string, uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'): string {
  return `uploads/${uuid}/${Buffer.from(filename, 'utf8').toString('base64url')}`;
}

/** A minimal valid PNG (signature + IHDR 3x2). */
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 3, 0, 0, 0, 2]),
]);
