import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { EviteClient } from '../src/client.js';
import { registerUploadTools } from '../src/tools/uploads.js';
import { BLOB_BASE, useFakeBlobStore } from './_blob.js';

const ENV_KEYS = ['MCP_DATA_DIR', 'MCP_BLOB_BASE_URL', 'MCP_BLOB_SIGNING_KEY'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const harness = () => createTestHarness((server) => registerUploadTools(server, {} as EviteClient));

interface Slot {
  filename: string;
  mimeType: string;
  blobKey: string;
  method: string;
  uploadUrl: string;
  expiresAt: string;
  curl: string;
}

describe('evite_upload_slots', () => {
  it('is registered read-only, and points at evite_upload_photo', async () => {
    const h = await harness();
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'evite_upload_slots');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description).toMatch(/evite_upload_photo/);
    expect(tool?.description).toMatch(/blob_key/);
    await h.close();
  });

  it('mints one signed PUT slot per image, without touching the network', async () => {
    const store = useFakeBlobStore();
    const h = await harness();
    const res = await h.callTool('evite_upload_slots', {
      files: [{ filename: 'party photo.jpg' }, { filename: 'cake.png', mimetype: 'image/png' }],
    });
    expect(res.isError).toBeFalsy();
    const body = parseToolResult(res) as { slots: Slot[]; next: string };
    expect(body.slots).toHaveLength(2);
    const [jpg, png] = body.slots;
    expect(jpg).toMatchObject({ filename: 'party photo.jpg', mimeType: 'image/jpeg', method: 'PUT' });
    expect(png).toMatchObject({ filename: 'cake.png', mimeType: 'image/png' });
    for (const s of body.slots) {
      expect(s.blobKey).toMatch(/^uploads\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+$/);
      expect(s.uploadUrl.startsWith(`${BLOB_BASE}/uploads/`)).toBe(true);
      expect(s.curl).toContain(`Content-Type: ${s.mimeType}`);
    }
    expect(body.next).toMatch(/evite_upload_photo/);
    expect(body.next).toMatch(/blob_key/);
    expect(store.spy).not.toHaveBeenCalled();
    await h.close();
  });

  it('refuses a non-image file type', async () => {
    useFakeBlobStore();
    const h = await harness();
    const res = await h.callTool('evite_upload_slots', { files: [{ filename: 'notes.txt' }] });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/only images/i);
    await h.close();
  });

  it('refuses a filename that is a path', async () => {
    useFakeBlobStore();
    const h = await harness();
    const res = await h.callTool('evite_upload_slots', { files: [{ filename: 'dir/cake.png' }] });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/bare filename/);
    await h.close();
  });

  it('refuses clearly when the server has no blob store (a local install)', async () => {
    const h = await harness();
    const res = await h.callTool('evite_upload_slots', { files: [{ filename: 'cake.png' }] });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res);
    expect(text).toMatch(/no blob store/);
    expect(text).toMatch(/path/);
    expect(text).toMatch(/inline/);
    await h.close();
  });
});
