import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { McpToolError } from '@chrischall/mcp-utils';
import { resolvePhotoSource } from '../src/photo-source.js';
import { PNG, uploadKey, useFakeBlobStore } from './_blob.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64');

const ENV_KEYS = ['EVITE_UPLOAD_DIR', 'MCP_DATA_DIR', 'MCP_BLOB_BASE_URL', 'MCP_BLOB_SIGNING_KEY'];
const saved: Record<string, string | undefined> = {};
let base: string;
let allowed: string;
let outside: string;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  base = mkdtempSync(join(tmpdir(), 'evite-source-'));
  allowed = join(base, 'allowed');
  outside = join(base, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  process.env.EVITE_UPLOAD_DIR = allowed;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const errorOf = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);

describe('resolvePhotoSource — exactly one of path | inline | blob_key', () => {
  it('refuses none', async () => {
    const err = await errorOf(resolvePhotoSource({}));
    expect(err?.message).toMatch(/exactly one of path, inline or blob_key/);
  });

  it('refuses two at once (and never vets the path first)', async () => {
    const err = await errorOf(
      resolvePhotoSource({ path: '/etc/passwd', inline: { filename: 'cake.png', content_base64: b64(PNG) } }),
    );
    expect(err?.message).toMatch(/exactly one of path, inline or blob_key/);
  });
});

describe('resolvePhotoSource — local path (unchanged confinement)', () => {
  it('reads an image inside EVITE_UPLOAD_DIR, resolving a relative path there', async () => {
    writeFileSync(join(allowed, 'cake.png'), PNG);
    const { source, resolvedPath } = await resolvePhotoSource({ path: 'cake.png' });
    expect(resolvedPath).toBe(join(allowed, 'cake.png'));
    expect(source.origin).toBe('path');
    expect(source.fileName).toBe('cake.png');
    expect(source.mimeType).toBe('image/png');
    expect(Buffer.from(source.bytes).equals(PNG)).toBe(true);
    expect(source.sha256).toBe(sha(PNG));
    expect(await source.release()).toEqual({ deleted: null });
  });

  it('refuses a path outside EVITE_UPLOAD_DIR with the EVITE_UPLOAD_DIR hint', async () => {
    const path = join(outside, 'photo.png');
    writeFileSync(path, PNG);
    process.env.EVITE_UPLOAD_DIR = `${join(base, 'nope')}${delimiter}${allowed}`;
    const err = await errorOf(resolvePhotoSource({ path }));
    expect(err).toBeInstanceOf(McpToolError);
    expect(err?.message).toMatch(/outside the allowed upload directories/);
    expect((err as McpToolError).hint).toMatch(/EVITE_UPLOAD_DIR/);
  });

  it('unset EVITE_UPLOAD_DIR confines uploads to ~/Downloads/evite-mcp (fleet-audit #1243)', async () => {
    delete process.env.EVITE_UPLOAD_DIR;
    const path = join(outside, 'photo.png');
    writeFileSync(path, PNG);
    const err = await errorOf(resolvePhotoSource({ path }));
    expect(err?.message).toMatch(/outside the allowed upload directories/);
    expect((err as McpToolError).hint).toMatch(/Downloads\/evite-mcp/);
  });

  it('refuses a hidden file or a file under a hidden directory', async () => {
    mkdirSync(join(allowed, '.ssh'));
    writeFileSync(join(allowed, '.ssh', 'photo.png'), PNG);
    writeFileSync(join(allowed, '.photo.png'), PNG);
    for (const path of [join(allowed, '.ssh', 'photo.png'), join(allowed, '.photo.png')]) {
      expect((await errorOf(resolvePhotoSource({ path })))?.message).toMatch(/hidden/);
    }
  });

  it('refuses a symlink that points outside, or at a hidden file', async () => {
    writeFileSync(join(outside, 'photo.png'), PNG);
    symlinkSync(join(outside, 'photo.png'), join(allowed, 'link.png'));
    writeFileSync(join(allowed, '.secret.png'), PNG);
    symlinkSync(join(allowed, '.secret.png'), join(allowed, 'innocent.png'));
    expect((await errorOf(resolvePhotoSource({ path: join(allowed, 'link.png') })))?.message).toMatch(
      /outside the allowed upload directories/,
    );
    expect((await errorOf(resolvePhotoSource({ path: join(allowed, 'innocent.png') })))?.message).toMatch(/hidden/);
  });

  it('refuses a missing file as unreadable', async () => {
    const err = await errorOf(resolvePhotoSource({ path: join(allowed, 'missing.png') }));
    expect(err?.message).toMatch(/cannot be read/);
  });

  it('refuses a non-image disguised with an image extension', async () => {
    writeFileSync(join(allowed, 'secrets.png'), 'EXAMPLE_PASSWORD=not-a-real-one\n');
    const err = await errorOf(resolvePhotoSource({ path: join(allowed, 'secrets.png') }));
    expect(err?.message).toMatch(/does not look like/);
  });

  it('refuses a file with no image extension (key files have none)', async () => {
    writeFileSync(join(allowed, 'id_ed25519'), PNG);
    const err = await errorOf(resolvePhotoSource({ path: join(allowed, 'id_ed25519') }));
    expect(err?.message).toMatch(/not an allowed type/);
  });

  it('refuses a file over the 20 MB cap', async () => {
    writeFileSync(join(allowed, 'big.png'), Buffer.concat([PNG, Buffer.alloc(20_000_001 - PNG.length)]));
    const err = await errorOf(resolvePhotoSource({ path: join(allowed, 'big.png') }));
    expect(err?.message).toMatch(/upload limit/);
  });
});

describe('resolvePhotoSource — hosted deployment', () => {
  it('refuses a path, pointing at the slot tool when a blob store exists', async () => {
    useFakeBlobStore();
    writeFileSync(join(allowed, 'cake.png'), PNG);
    const err = await errorOf(resolvePhotoSource({ path: join(allowed, 'cake.png') }));
    expect(err?.message).toMatch(/remote and can't read files on your machine/);
    expect(err?.message).toMatch(/evite_upload_slots/);
    expect(err?.message).toMatch(/blob_key/);
  });

  it('refuses a path, pointing at inline when there is no blob store', async () => {
    process.env.MCP_DATA_DIR = join(base, 'data');
    const err = await errorOf(resolvePhotoSource({ path: 'cake.png' }));
    expect(err?.message).toMatch(/remote and can't read files on your machine/);
    expect(err?.message).toMatch(/inline/);
    expect(err?.message).not.toMatch(/outside the allowed upload directories/);
  });
});

describe('resolvePhotoSource — inline base64', () => {
  it('decodes an image', async () => {
    const { source, resolvedPath } = await resolvePhotoSource({
      inline: { filename: 'party photo.png', content_base64: b64(PNG) },
    });
    expect(resolvedPath).toBeUndefined();
    expect(source).toMatchObject({ origin: 'inline', fileName: 'party photo.png', mimeType: 'image/png' });
    expect(source.sha256).toBe(sha(PNG));
  });

  it('honours a mimetype override that matches the bytes', async () => {
    const { source } = await resolvePhotoSource({
      inline: { filename: 'photo', content_base64: b64(PNG) },
      mimetype: 'image/png',
    });
    expect(source.mimeType).toBe('image/png');
  });

  it('refuses bad base64', async () => {
    const err = await errorOf(resolvePhotoSource({ inline: { filename: 'cake.png', content_base64: 'not base64!!' } }));
    expect(err?.message).toMatch(/not valid base64/);
  });

  it('refuses a non-image type', async () => {
    const err = await errorOf(resolvePhotoSource({ inline: { filename: 'notes.txt', content_base64: b64('hello') } }));
    expect(err?.message).toMatch(/text\/plain is not accepted/);
  });

  it('refuses non-image bytes named as an image', async () => {
    const err = await errorOf(resolvePhotoSource({ inline: { filename: 'cake.png', content_base64: b64('hello there') } }));
    expect(err?.message).toMatch(/do not look like image\/png/);
  });
});

describe('resolvePhotoSource — blob_key (upload slot)', () => {
  it('reads the uploaded image back and deletes it only on release()', async () => {
    const store = useFakeBlobStore();
    const key = uploadKey('cake.png');
    store.put(key, PNG, 'image/png');
    const { source } = await resolvePhotoSource({ blob_key: key });
    expect(source).toMatchObject({ origin: 'blob', blobKey: key, fileName: 'cake.png', mimeType: 'image/png' });
    expect(source.sha256).toBe(sha(PNG));
    expect(store.calls).toEqual([{ method: 'GET', key }]);
    expect(store.objects.has(key)).toBe(true);
    expect(await source.release()).toEqual({ deleted: true });
    expect(store.objects.has(key)).toBe(false);
  });

  it('refuses a key that is not an upload-slot key', async () => {
    useFakeBlobStore();
    const err = await errorOf(resolvePhotoSource({ blob_key: 'exports/whatever.zip' }));
    expect(err?.message).toMatch(/not an upload key/);
  });

  it('refuses a blob that is not an image', async () => {
    const store = useFakeBlobStore();
    const key = uploadKey('cake.png');
    store.put(key, Buffer.from('plain text'), 'image/png');
    const err = await errorOf(resolvePhotoSource({ blob_key: key }));
    expect(err?.message).toMatch(/do not look like image\/png/);
  });

  it('refuses blob_key when the server has no blob store', async () => {
    const err = await errorOf(resolvePhotoSource({ blob_key: uploadKey('cake.png') }));
    expect(err?.message).toMatch(/no blob store/);
  });
});
