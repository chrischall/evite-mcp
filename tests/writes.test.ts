import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIRM_FLOW_SENTENCE } from '@chrischall/mcp-utils';
import { createTestHarness, parseToolResult, type TestHarnessOptions } from '@chrischall/mcp-utils/test';
import type { EviteClient } from '../src/client.js';
import { registerWriteTools } from '../src/tools/writes.js';
import { PNG, uploadKey, useFakeBlobStore } from './_blob.js';

/**
 * A fake EviteClient whose write methods are spies returning a canned result.
 * The READ methods are present too (some tools may describe an event), but the
 * tests assert on the WRITE spies.
 *
 * SAFETY: no real client is constructed in these tests, so no fetch is ever
 * issued. Preview-path tests additionally assert the write spies were NOT
 * called.
 */
function fakeClient() {
  return {
    rsvp: vi.fn(async () => ({ ok: true })),
    sendMessage: vi.fn(async () => ({ ok: true })),
    broadcast: vi.fn(async () => ({ ok: true })),
    listMessages: vi.fn(async () => ({
      posts: [
        { id: 'POST1', message: 'older', created: '2026-05-19T10:00:00.000Z' },
        { id: 'POST2', message: 'newest', created: '2026-05-20T12:00:00.000Z' },
      ],
    })),
    createEvent: vi.fn(async () => ({ event: { id: 'NEW' } })),
    updateEvent: vi.fn(async () => ({ event: { id: 'EVENTID0' } })),
    addGuest: vi.fn(async () => ({ ok: true })),
    // The merged PATCH body: the guest's stored invite method/phone kept.
    buildGuestUpdate: vi.fn(async (eventId: string, guestId: string, patch: { name: string; email: string; phone?: string }) => ({
      guest_id: guestId,
      event_id: eventId,
      invite_method: 'sms',
      name: patch.name,
      email: patch.email,
      phone: patch.phone ?? '+15551234567',
    })),
    updateGuest: vi.fn(async () => ({ ok: true })),
    removeGuest: vi.fn(async () => ({ ok: true })),
    sendInvitation: vi.fn(async () => ({ ok: true })),
    cancelEvent: vi.fn(async () => ({ ok: true })),
    reinstateEvent: vi.fn(async () => ({ ok: true })),
    duplicateEvent: vi.fn(async () => ({ newEventId: 'NEW', customizeUrl: '/invitation/NEW/customize' })),
    uploadPhoto: vi.fn(async () => ({ photoId: 'PHOTO9', accessUrl: 'https://x/PHOTO9' })),
  } as unknown as EviteClient & {
    rsvp: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    createEvent: ReturnType<typeof vi.fn>;
    updateEvent: ReturnType<typeof vi.fn>;
    addGuest: ReturnType<typeof vi.fn>;
    buildGuestUpdate: ReturnType<typeof vi.fn>;
    updateGuest: ReturnType<typeof vi.fn>;
    removeGuest: ReturnType<typeof vi.fn>;
    sendInvitation: ReturnType<typeof vi.fn>;
    cancelEvent: ReturnType<typeof vi.fn>;
    reinstateEvent: ReturnType<typeof vi.fn>;
    duplicateEvent: ReturnType<typeof vi.fn>;
    broadcast: ReturnType<typeof vi.fn>;
    listMessages: ReturnType<typeof vi.fn>;
    uploadPhoto: ReturnType<typeof vi.fn>;
  };
}

/**
 * A harness created WITHOUT an elicitation handler is a client that cannot be
 * prompted, so (default MCP_CONFIRM_MODE=ask-user) every write goes through the
 * two-phase preview-token flow.
 */
async function harnessFor(client: EviteClient, opts?: TestHarnessOptions) {
  return createTestHarness((server) => registerWriteTools(server, client), opts);
}

type Harness = Awaited<ReturnType<typeof harnessFor>>;

interface PhaseOne {
  status: string;
  action: string;
  confirmToken: string;
  preview: { willSend: Record<string, unknown>; caveat?: string };
}

/** Phase 1: no token — returns the preview and a confirmToken, writes nothing. */
async function phaseOne(h: Harness, tool: string, args: Record<string, unknown>): Promise<PhaseOne> {
  const res = await h.callTool(tool, args);
  expect(res.isError).toBeFalsy();
  const body = parseToolResult(res) as PhaseOne;
  expect(body.status).toBe('confirmation-required');
  expect(typeof body.confirmToken).toBe('string');
  return body;
}

/** Both phases: preview, then the same call with the returned token. */
async function confirmed(h: Harness, tool: string, args: Record<string, unknown>) {
  const p1 = await phaseOne(h, tool, args);
  const res = await h.callTool(tool, { ...args, confirmToken: p1.confirmToken });
  return { p1, res };
}

/** A fetch spy that MUST never be called in these tool tests. */
function guardFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('fetch must not be called in write-tool tests');
  });
}

const savedEnv = { ...process.env };
beforeEach(() => {
  delete process.env.MCP_CONFIRM_MODE;
  delete process.env.MCP_CONFIRM_TTL_SECONDS;
  delete process.env.MCP_CONFIRM_SECRET;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('write tool registration', () => {
  it('registers the thirteen write tools, all readOnlyHint:false', async () => {
    const h = await harnessFor(fakeClient());
    const tools = (await h.client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'evite_add_guest',
        'evite_broadcast',
        'evite_cancel_event',
        'evite_create_event',
        'evite_duplicate_event',
        'evite_reinstate_event',
        'evite_remove_guest',
        'evite_rsvp',
        'evite_send',
        'evite_send_message',
        'evite_update_event',
        'evite_update_guest',
        'evite_upload_photo',
      ].sort(),
    );
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(false);
      // The confirm boolean is gone; the token is the only confirmation input.
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props).not.toHaveProperty('confirm');
      expect(props).toHaveProperty('confirmToken');
      // The shared kit's flow sentence (mcp-utils confirmWrite), not a local copy.
      expect(t.description).toContain(CONFIRM_FLOW_SENTENCE);
    }
    await h.close();
  });
});

describe('write tool annotations (fleet-audit #439)', () => {
  it('marks the in-place overwrite and DELETE tools destructive', async () => {
    const h = await harnessFor(fakeClient());
    const byName = new Map((await h.client.listTools()).tools.map((t) => [t.name, t]));
    for (const name of ['evite_remove_guest', 'evite_update_event', 'evite_update_guest']) {
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(true);
    }
    expect(byName.get('evite_remove_guest')?.annotations?.idempotentHint).toBe(true);
    await h.close();
  });
});

describe('evite_rsvp', () => {
  const args = {
    event_id: 'EVENTID0',
    guest_id: 'GUEST9',
    response: 'yes',
    number_of_adults: 2,
    number_of_kids: 1,
    note: 'see you there',
  };

  it('phase 1: returns a preview + token and makes NO network/client call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_rsvp', args);
    expect(client.rsvp).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.action).toBe('evite.rsvp');
    expect(p1.preview.willSend).toEqual(args);
    await h.close();
  });

  it('phase 2: with the token, calls client.rsvp once with the mapped fields', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const { res } = await confirmed(h, 'evite_rsvp', { ...args, response: 'maybe', note: undefined });
    expect(client.rsvp).toHaveBeenCalledTimes(1);
    expect(client.rsvp).toHaveBeenCalledWith('EVENTID0', 'GUEST9', {
      response: 'maybe',
      numberOfAdults: 2,
      numberOfKids: 1,
      note: undefined,
    });
    expect(parseToolResult(res)).toEqual({ ok: true });
    await h.close();
  });

  it('rejects an out-of-enum response', async () => {
    const h = await harnessFor(fakeClient());
    const res = await h.callTool('evite_rsvp', {
      event_id: 'E',
      guest_id: 'G',
      response: 'bogus',
      number_of_adults: 0,
      number_of_kids: 0,
    });
    expect(res.isError).toBe(true);
    await h.close();
  });

  it('rejects the retired confirm: true — it no longer bypasses the gate', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_rsvp', { ...args, confirm: true });
    // Unknown keys are stripped by zod, so this is just a phase-1 call.
    expect((parseToolResult(res) as PhaseOne).status).toBe('confirmation-required');
    expect(client.rsvp).not.toHaveBeenCalled();
    await h.close();
  });
});

describe('evite_send_message', () => {
  const args = { event_id: 'EVENTID0', guest_id: 'GUEST9', message: 'hello all' };

  it('phase 1: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_send_message', args);
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.willSend).toEqual(args);
    // Issue #3: delivery is a Firebase RTDB push, not a REST call — the preview
    // says so, but it is a real send once confirmed.
    expect(p1.preview.caveat).toMatch(/rtdb|firebase/i);
    await h.close();
  });

  it('phase 2: calls client.sendMessage once', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_send_message', args);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith('EVENTID0', 'GUEST9', { message: 'hello all' });
    await h.close();
  });
});

describe('evite_broadcast', () => {
  const args = {
    event_id: 'EVENTID0',
    message: 'See you Saturday!',
    groups: ['yes', 'maybe'],
    participant_count: 4,
  };

  it('phase 1: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_broadcast', args);
    expect(client.broadcast).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.willSend).toEqual(args);
    await h.close();
  });

  it('phase 2: calls client.broadcast once with message, groups, participantCount', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_broadcast', args);
    expect(client.broadcast).toHaveBeenCalledTimes(1);
    expect(client.broadcast).toHaveBeenCalledWith('EVENTID0', {
      message: 'See you Saturday!',
      groups: ['yes', 'maybe'],
      participantCount: 4,
    });
    await h.close();
  });
});

describe('evite_broadcast — bound to the event thread as read (fleet-audit #1188)', () => {
  const args = { event_id: 'EVENTID0', message: 'See you Saturday!', groups: ['yes'] };

  it('phase 1 reads the messages thread and shows its latest post', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_broadcast', args);
    expect(client.listMessages).toHaveBeenCalledWith('EVENTID0');
    const preview = p1.preview as unknown as Record<string, any>;
    expect(preview.messages_thread).toEqual({
      post_count: 2,
      latest_post_id: 'POST2',
      latest_post_at: '2026-05-20T12:00:00.000Z',
    });
    expect(preview.caveat).toMatch(/evite_list_messages/);
    await h.close();
  });

  it('a post landing between preview and confirm is refused as DRAFT_CHANGED and broadcasts nothing', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_broadcast', args);
    client.listMessages.mockResolvedValueOnce({
      posts: [
        { id: 'POST1', created: '2026-05-19T10:00:00.000Z' },
        { id: 'POST2', created: '2026-05-20T12:00:00.000Z' },
        { id: 'POST3', created: '2026-05-21T08:00:00.000Z' },
      ],
    });
    const res = await h.callTool('evite_broadcast', { ...args, confirmToken: p1.confirmToken });
    expect(JSON.stringify(parseToolResult(res))).toMatch(/DRAFT_CHANGED/);
    expect(client.broadcast).not.toHaveBeenCalled();
    await h.close();
  });

  it('accepts the other post field spellings and an empty thread', async () => {
    const client = fakeClient();
    client.listMessages.mockResolvedValueOnce({ posts: [{ postId: 'P9', createdAt: 'T9' }] });
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_broadcast', args);
    expect((p1.preview as unknown as Record<string, any>).messages_thread).toEqual({
      post_count: 1,
      latest_post_id: 'P9',
      latest_post_at: 'T9',
    });
    client.listMessages.mockResolvedValueOnce({ posts: [] });
    const p2 = await phaseOne(h, 'evite_broadcast', { ...args, message: 'other' });
    expect((p2.preview as unknown as Record<string, any>).messages_thread).toEqual({ post_count: 0 });
    client.listMessages.mockResolvedValueOnce({});
    const p3 = await phaseOne(h, 'evite_broadcast', { ...args, message: 'third' });
    expect((p3.preview as unknown as Record<string, any>).messages_thread).toEqual({ post_count: 0 });
    client.listMessages.mockResolvedValueOnce({ posts: [{ message: 'no id or time' }] });
    const p4 = await phaseOne(h, 'evite_broadcast', { ...args, message: 'fourth' });
    expect((p4.preview as unknown as Record<string, any>).messages_thread).toEqual({ post_count: 1 });
    client.listMessages.mockRejectedValueOnce('plain string');
    const p5 = await phaseOne(h, 'evite_broadcast', { ...args, message: 'fifth' });
    expect((p5.preview as unknown as Record<string, any>).messages_thread).toEqual({
      unavailable: 'could not read the messages thread: plain string',
    });
    await h.close();
  });

  it('still previews when the thread cannot be read, and says so', async () => {
    const client = fakeClient();
    client.listMessages.mockRejectedValue(new Error('boom'));
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_broadcast', args);
    expect((p1.preview as unknown as Record<string, any>).messages_thread).toEqual({
      unavailable: 'could not read the messages thread: boom',
    });
    await confirmed(h, 'evite_broadcast', { ...args, message: 'again' });
    expect(client.broadcast).toHaveBeenCalledTimes(1);
    await h.close();
  });
});

describe('evite_upload_photo', () => {
  // Uploads are confined to EVITE_UPLOAD_DIR (default ~/Downloads/evite-mcp);
  // these tests put their files in a fresh temp dir and confine there. The
  // hosted env is cleared so a developer's shell cannot flip the path route.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evite-upload-'));
    process.env.EVITE_UPLOAD_DIR = dir;
    delete process.env.MCP_DATA_DIR;
    delete process.env.MCP_BLOB_BASE_URL;
    delete process.env.MCP_BLOB_SIGNING_KEY;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64');
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

  it('documents all three routes and the hosted slot flow', async () => {
    const h = await harnessFor(fakeClient());
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'evite_upload_photo')!;
    expect(tool.description).toMatch(/evite_upload_slots/);
    const props = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['path', 'inline', 'blob_key']));
    await h.close();
  });

  it('refuses none of path | inline | blob_key before the gate', async () => {
    guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_upload_photo', { event_id: 'E', guest_id: 'G' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/exactly one of path, inline or blob_key/);
    expect(JSON.stringify(res)).not.toMatch(/confirmToken/);
    expect(client.uploadPhoto).not.toHaveBeenCalled();
    await h.close();
  });

  it('refuses two routes at once', async () => {
    guardFetch();
    const h = await harnessFor(fakeClient());
    const res = await h.callTool('evite_upload_photo', {
      event_id: 'E',
      guest_id: 'G',
      path: 'cake.png',
      inline: { filename: 'cake.png', content_base64: b64(PNG) },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/exactly one of path, inline or blob_key/);
    await h.close();
  });

  describe('local path (unchanged)', () => {
    it('refuses a path outside the upload directory BEFORE the gate, revealing nothing about it (#1243)', async () => {
      guardFetch();
      const outside = mkdtempSync(join(tmpdir(), 'evite-outside-'));
      const file = join(outside, 'id_ed25519');
      writeFileSync(file, Buffer.alloc(4321));
      try {
        const client = fakeClient();
        const h = await harnessFor(client);
        const res = await h.callTool('evite_upload_photo', { event_id: 'E', guest_id: 'G', path: file });
        expect(res.isError).toBe(true);
        const text = JSON.stringify(res);
        expect(text).toMatch(/outside the allowed upload directories/);
        expect(text).not.toMatch(/4321|size_bytes|confirmToken/);
        expect(client.uploadPhoto).not.toHaveBeenCalled();
        await h.close();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('refuses a hidden path inside the upload directory before the gate', async () => {
      guardFetch();
      const h = await harnessFor(fakeClient());
      const res = await h.callTool('evite_upload_photo', { event_id: 'E', guest_id: 'G', path: '.ssh/id_ed25519' });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toMatch(/hidden/);
      expect(JSON.stringify(res)).not.toMatch(/size_bytes|confirmToken/);
      await h.close();
    });

    it('phase 1: previews the resolved path, size and sha256, and makes no call', async () => {
      const fetchSpy = guardFetch();
      writeFileSync(join(dir, 'cake.png'), PNG);
      const client = fakeClient();
      const h = await harnessFor(client);
      const p1 = await phaseOne(h, 'evite_upload_photo', { event_id: 'EVENTID0', guest_id: 'GUEST9', path: 'cake.png' });
      expect(client.uploadPhoto).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(p1.preview.willSend).toMatchObject({
        source: 'path',
        path: 'cake.png',
        resolved_path: join(dir, 'cake.png'),
        file_name: 'cake.png',
        mimetype: 'image/png',
        size_bytes: PNG.length,
        sha256: sha(PNG),
      });
      await h.close();
    });

    it('expands a ~ path against the home directory', async () => {
      guardFetch();
      delete process.env.EVITE_UPLOAD_DIR; // the default root, ~/Downloads/evite-mcp
      const h = await harnessFor(fakeClient());
      const res = await h.callTool('evite_upload_photo', {
        event_id: 'E',
        guest_id: 'G',
        path: '~/Downloads/evite-mcp/evite-mcp-no-such-file.png',
      });
      // A missing file is now refused at the preview, naming the resolved path.
      expect(res.isError).toBe(true);
      const text = JSON.stringify(res);
      expect(text).toContain(join(homedir(), 'Downloads', 'evite-mcp', 'evite-mcp-no-such-file.png'));
      expect(text).toMatch(/cannot be read/);
      await h.close();
    });

    it('refuses the token when the file changed between preview and upload (DRAFT_CHANGED)', async () => {
      const file = join(dir, 'cake.png');
      writeFileSync(file, PNG);
      const client = fakeClient();
      const h = await harnessFor(client);
      const args = { event_id: 'E', guest_id: 'G', path: file };
      const p1 = await phaseOne(h, 'evite_upload_photo', args);
      writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(10)]));
      const res = await h.callTool('evite_upload_photo', { ...args, confirmToken: p1.confirmToken });
      expect(res.isError).toBe(true);
      expect((parseToolResult(res) as { error: string }).error).toBe('DRAFT_CHANGED');
      expect(client.uploadPhoto).not.toHaveBeenCalled();
      await h.close();
    });

    it('refuses the token when a same-size file replaced it between preview and upload (DRAFT_CHANGED)', async () => {
      const file = join(dir, 'cake.png');
      writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(10, 1)]));
      const client = fakeClient();
      const h = await harnessFor(client);
      const args = { event_id: 'E', guest_id: 'G', path: file };
      const p1 = await phaseOne(h, 'evite_upload_photo', args);
      writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(10, 2)])); // same size, different bytes
      const res = await h.callTool('evite_upload_photo', { ...args, confirmToken: p1.confirmToken });
      expect(res.isError).toBe(true);
      expect((parseToolResult(res) as { error: string }).error).toBe('DRAFT_CHANGED');
      expect(client.uploadPhoto).not.toHaveBeenCalled();
      await h.close();
    });

    it('rejects a mimetype outside the supported image types at the schema', async () => {
      const client = fakeClient();
      const h = await harnessFor(client);
      const res = await h.callTool('evite_upload_photo', {
        event_id: 'E',
        guest_id: 'G',
        path: '~/.ssh/id_ed25519',
        mimetype: 'text/plain',
      });
      expect(res.isError).toBe(true);
      expect(client.uploadPhoto).not.toHaveBeenCalled();
      await h.close();
    });

    it('phase 2: calls client.uploadPhoto once with the file bytes, and reports no blob', async () => {
      writeFileSync(join(dir, 'cake.png'), PNG);
      const client = fakeClient();
      const h = await harnessFor(client);
      const { res } = await confirmed(h, 'evite_upload_photo', {
        event_id: 'EVENTID0',
        guest_id: 'GUEST9',
        path: 'cake.png',
      });
      expect(res.isError).toBeFalsy();
      expect(client.uploadPhoto).toHaveBeenCalledTimes(1);
      const [eventId, input] = client.uploadPhoto.mock.calls[0]! as [string, Record<string, unknown>];
      expect(eventId).toBe('EVENTID0');
      expect(input).toMatchObject({ guestId: 'GUEST9', fileName: 'cake.png', mimetype: 'image/png' });
      expect(Buffer.from(input.bytes as Uint8Array).equals(PNG)).toBe(true);
      const body = parseToolResult(res) as Record<string, unknown>;
      expect(body.photoId).toBe('PHOTO9');
      expect(body).not.toHaveProperty('blob');
      await h.close();
    });

    it('passes an explicit mimetype through to the client', async () => {
      writeFileSync(join(dir, 'cake.png'), PNG);
      const client = fakeClient();
      const h = await harnessFor(client);
      await confirmed(h, 'evite_upload_photo', { event_id: 'E', guest_id: 'G', path: 'cake.png', mimetype: 'image/png' });
      expect(client.uploadPhoto.mock.calls[0]![1]).toMatchObject({ mimetype: 'image/png' });
      await h.close();
    });
  });

  describe('inline base64', () => {
    it('previews and uploads the decoded image', async () => {
      guardFetch();
      const client = fakeClient();
      const h = await harnessFor(client);
      const args = { event_id: 'E', guest_id: 'G', inline: { filename: 'party photo.png', content_base64: b64(PNG) } };
      const { p1, res } = await confirmed(h, 'evite_upload_photo', args);
      expect(p1.preview.willSend).toMatchObject({
        source: 'inline',
        file_name: 'party photo.png',
        mimetype: 'image/png',
        size_bytes: PNG.length,
        sha256: sha(PNG),
      });
      expect(p1.preview.willSend).not.toHaveProperty('path');
      expect(res.isError).toBeFalsy();
      expect(client.uploadPhoto.mock.calls[0]![1]).toMatchObject({ fileName: 'party photo.png', mimetype: 'image/png' });
      await h.close();
    });

    it('refuses bad base64 before the gate', async () => {
      guardFetch();
      const client = fakeClient();
      const h = await harnessFor(client);
      const res = await h.callTool('evite_upload_photo', {
        event_id: 'E',
        guest_id: 'G',
        inline: { filename: 'cake.png', content_base64: 'not base64!!' },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toMatch(/not valid base64/);
      expect(client.uploadPhoto).not.toHaveBeenCalled();
      await h.close();
    });

    it('refuses a non-image before the gate', async () => {
      guardFetch();
      const client = fakeClient();
      const h = await harnessFor(client);
      const res = await h.callTool('evite_upload_photo', {
        event_id: 'E',
        guest_id: 'G',
        inline: { filename: 'notes.txt', content_base64: b64('hello') },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toMatch(/not accepted/);
      expect(client.uploadPhoto).not.toHaveBeenCalled();
      await h.close();
    });
  });

  describe('hosted', () => {
    it('refuses a path with the slot-flow instructions, before the gate', async () => {
      useFakeBlobStore();
      writeFileSync(join(dir, 'cake.png'), PNG);
      const client = fakeClient();
      const h = await harnessFor(client);
      const res = await h.callTool('evite_upload_photo', { event_id: 'E', guest_id: 'G', path: 'cake.png' });
      expect(res.isError).toBe(true);
      const text = JSON.stringify(res);
      expect(text).toMatch(/remote and can't read files on your machine/);
      expect(text).toMatch(/evite_upload_slots/);
      expect(text).not.toMatch(/confirmToken/);
      expect(client.uploadPhoto).not.toHaveBeenCalled();
      await h.close();
    });
  });

  describe('blob_key (upload slot)', () => {
    it('binds sha256 in the preview, uploads on confirm, then deletes the blob and reports it', async () => {
      const store = useFakeBlobStore();
      const key = uploadKey('cake.png');
      store.put(key, PNG, 'image/png');
      const client = fakeClient();
      const h = await harnessFor(client);
      const args = { event_id: 'E', guest_id: 'G', blob_key: key };
      const p1 = await phaseOne(h, 'evite_upload_photo', args);
      expect(p1.preview.willSend).toMatchObject({ source: 'blob', blob_key: key, file_name: 'cake.png', sha256: sha(PNG) });
      expect(store.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
      const res = await h.callTool('evite_upload_photo', { ...args, confirmToken: p1.confirmToken });
      expect(res.isError).toBeFalsy();
      expect(client.uploadPhoto).toHaveBeenCalledTimes(1);
      expect(client.uploadPhoto.mock.calls[0]![1]).toMatchObject({ fileName: 'cake.png', mimetype: 'image/png' });
      expect(parseToolResult(res)).toMatchObject({ photoId: 'PHOTO9', blob: { blob_key: key, deleted: true } });
      expect(store.objects.has(key)).toBe(false);
      // The delete came after the read on the confirmed call, never before.
      expect(store.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'DELETE']);
      await h.close();
    });

    it('keeps the blob when Evite refuses the photo', async () => {
      const store = useFakeBlobStore();
      const key = uploadKey('cake.png');
      store.put(key, PNG, 'image/png');
      const client = fakeClient();
      client.uploadPhoto.mockRejectedValueOnce(new Error('Evite upload/request did not return a usable upload ticket.'));
      const h = await harnessFor(client);
      const { res } = await confirmed(h, 'evite_upload_photo', { event_id: 'E', guest_id: 'G', blob_key: key });
      expect(res.isError).toBe(true);
      expect(store.objects.has(key)).toBe(true);
      expect(store.calls.some((c) => c.method === 'DELETE')).toBe(false);
      await h.close();
    });

    it('reports (does not throw) a failed delete after a successful upload', async () => {
      const store = useFakeBlobStore();
      const key = uploadKey('cake.png');
      store.put(key, PNG, 'image/png');
      store.failDeletes();
      const client = fakeClient();
      const h = await harnessFor(client);
      const { res } = await confirmed(h, 'evite_upload_photo', { event_id: 'E', guest_id: 'G', blob_key: key });
      expect(res.isError).toBeFalsy();
      const body = parseToolResult(res) as { photoId: string; blob: { deleted: boolean; error?: string } };
      expect(body.photoId).toBe('PHOTO9');
      expect(body.blob.deleted).toBe(false);
      expect(body.blob.error).toMatch(/HTTP 500/);
      await h.close();
    });

    it('refuses a blob that changed between preview and confirm (DRAFT_CHANGED), keeping it', async () => {
      const store = useFakeBlobStore();
      const key = uploadKey('cake.png');
      store.put(key, PNG, 'image/png');
      const client = fakeClient();
      const h = await harnessFor(client);
      const args = { event_id: 'E', guest_id: 'G', blob_key: key };
      const p1 = await phaseOne(h, 'evite_upload_photo', args);
      store.put(key, Buffer.concat([PNG, Buffer.alloc(4)]), 'image/png');
      const res = await h.callTool('evite_upload_photo', { ...args, confirmToken: p1.confirmToken });
      expect(res.isError).toBe(true);
      expect((parseToolResult(res) as { error: string }).error).toBe('DRAFT_CHANGED');
      expect(client.uploadPhoto).not.toHaveBeenCalled();
      expect(store.objects.has(key)).toBe(true);
      await h.close();
    });
  });
});

describe('evite_create_event', () => {
  const args = {
    title: 'Pool Party',
    start_datetime: '2026-07-01T18:00:00',
    template_name: 'camp-confetti',
    message: 'come swim',
  };

  it('phase 1: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_create_event', args);
    expect(client.createEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.willSend).toEqual(args);
    // create returns a 500 even on success — the preview should warn about that
    expect(p1.preview.caveat).toMatch(/500/i);
    await h.close();
  });

  it('phase 2: calls client.createEvent once with mapped input', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_create_event', args);
    expect(client.createEvent).toHaveBeenCalledTimes(1);
    expect(client.createEvent).toHaveBeenCalledWith({
      title: 'Pool Party',
      startDatetime: '2026-07-01T18:00:00',
      templateName: 'camp-confetti',
      endDatetime: undefined,
      message: 'come swim',
    });
    await h.close();
  });
});

describe('evite_update_event', () => {
  it('phase 1: previews the wire patch and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_update_event', { event_id: 'EVENTID0', title: 'Renamed' });
    expect(client.updateEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.willSend).toEqual({ event_id: 'EVENTID0', patch: { title: 'Renamed' } });
    await h.close();
  });

  it('phase 2: calls client.updateEvent once with only the provided fields', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_update_event', { event_id: 'EVENTID0', title: 'Renamed' });
    expect(client.updateEvent).toHaveBeenCalledTimes(1);
    expect(client.updateEvent).toHaveBeenCalledWith('EVENTID0', { title: 'Renamed' });
    await h.close();
  });

  it('maps every snake_case field → the wire patch', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_update_event', {
      event_id: 'EVENTID0', title: 'New Title',
      start_datetime: '2026-07-01T18:00:00Z', end_datetime: '2026-07-01T21:00:00Z',
      message: 'Updated details',
    });
    expect(client.updateEvent).toHaveBeenCalledWith('EVENTID0', {
      title: 'New Title', startDatetime: '2026-07-01T18:00:00Z', endDatetime: '2026-07-01T21:00:00Z', message: 'Updated details',
    });
    await h.close();
  });

  it('requires at least one field to change (refused before any preview or token)', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_update_event', { event_id: 'EVENTID0' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text as string).toMatch(/at least one field/);
    expect(client.updateEvent).not.toHaveBeenCalled();
    await h.close();
  });
});

describe('evite_add_guest', () => {
  const guests = [{ name: 'A', email: 'a@example.com' }];

  it('phase 1: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_add_guest', { event_id: 'EVENTID0', guests });
    expect(client.addGuest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.willSend).toEqual({ event_id: 'EVENTID0', guests });
    await h.close();
  });

  it('phase 2: calls client.addGuest once with the guest list', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_add_guest', { event_id: 'EVENTID0', guests });
    expect(client.addGuest).toHaveBeenCalledTimes(1);
    expect(client.addGuest).toHaveBeenCalledWith('EVENTID0', guests);
    await h.close();
  });
});

describe('evite_update_guest', () => {
  const args = { event_id: 'EVENTID0', guest_id: 'GUEST9', name: 'New', email: 'new@example.com' };
  // fleet-audit #436: the preview shows the object that will actually be sent,
  // with the guest's stored invite method and phone merged in.
  const merged = {
    guest_id: 'GUEST9',
    event_id: 'EVENTID0',
    invite_method: 'sms',
    name: 'New',
    email: 'new@example.com',
    phone: '+15551234567',
  };

  it('phase 1: previews the merged PATCH body and makes no write', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_update_guest', args);
    expect(client.updateGuest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.buildGuestUpdate).toHaveBeenCalledWith('EVENTID0', 'GUEST9', {
      name: 'New',
      email: 'new@example.com',
      phone: undefined,
    });
    expect(p1.preview.willSend).toEqual(merged);
    await h.close();
  });

  it('phase 2: sends exactly the previewed body once', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_update_guest', args);
    expect(client.updateGuest).toHaveBeenCalledTimes(1);
    expect(client.updateGuest).toHaveBeenCalledWith('EVENTID0', merged);
    await h.close();
  });
});

describe('evite_remove_guest', () => {
  it('phase 1: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_remove_guest', { event_id: 'EV', guest_id: 'G' });
    expect(client.removeGuest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.willSend).toEqual({ event_id: 'EV', guest_id: 'G' });
    await h.close();
  });

  it('phase 2: calls client.removeGuest once', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_remove_guest', { event_id: 'EV', guest_id: 'G' });
    expect(client.removeGuest).toHaveBeenCalledTimes(1);
    expect(client.removeGuest).toHaveBeenCalledWith('EV', 'G');
    await h.close();
  });
});

describe('evite_send', () => {
  it('phase 1: previews (warns it emails) and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_send', { event_id: 'EVENTID0' });
    expect(client.sendInvitation).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.willSend).toEqual({ event_id: 'EVENTID0' });
    expect(p1.preview.caveat).toMatch(/email/i);
    await h.close();
  });

  it('phase 2: calls client.sendInvitation once', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_send', { event_id: 'EVENTID0' });
    expect(client.sendInvitation).toHaveBeenCalledTimes(1);
    expect(client.sendInvitation).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });
});

describe('evite_cancel_event', () => {
  it('phase 1: previews (warns destructive) and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_cancel_event', { event_id: 'EVENTID0' });
    expect(client.cancelEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.caveat).toMatch(/destructive/i);
    await h.close();
  });

  it('phase 2: calls client.cancelEvent once', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_cancel_event', { event_id: 'EVENTID0' });
    expect(client.cancelEvent).toHaveBeenCalledTimes(1);
    expect(client.cancelEvent).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });
});

describe('evite_reinstate_event', () => {
  it('phase 1: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_reinstate_event', { event_id: 'EV' });
    expect(client.reinstateEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.willSend).toEqual({ event_id: 'EV' });
    await h.close();
  });

  it('phase 2: calls client.reinstateEvent once', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_reinstate_event', { event_id: 'EV' });
    expect(client.reinstateEvent).toHaveBeenCalledTimes(1);
    expect(client.reinstateEvent).toHaveBeenCalledWith('EV');
    await h.close();
  });
});

describe('evite_duplicate_event', () => {
  it('phase 1: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_duplicate_event', { event_id: 'EVENTID0' });
    expect(client.duplicateEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.willSend).toEqual({ event_id: 'EVENTID0' });
    await h.close();
  });

  it('phase 2: calls client.duplicateEvent once', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_duplicate_event', { event_id: 'EVENTID0' });
    expect(client.duplicateEvent).toHaveBeenCalledTimes(1);
    expect(client.duplicateEvent).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });
});

describe('confirmation token rules', () => {
  const sendArgs = { event_id: 'EVENTID0', guest_id: 'GUEST9', message: 'hello all' };

  it('a used token cannot be replayed (TOKEN_REUSED, no second write)', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const { p1 } = await confirmed(h, 'evite_send_message', sendArgs);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const replay = await h.callTool('evite_send_message', { ...sendArgs, confirmToken: p1.confirmToken });
    expect(replay.isError).toBe(true);
    expect((parseToolResult(replay) as { error: string }).error).toBe('TOKEN_REUSED');
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it('changing an argument between the phases is refused (DRAFT_CHANGED, no write)', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_send_message', sendArgs);
    const res = await h.callTool('evite_send_message', {
      ...sendArgs,
      message: 'something else entirely',
      confirmToken: p1.confirmToken,
    });
    expect(res.isError).toBe(true);
    const body = parseToolResult(res) as { error: string; preview: PhaseOne['preview'] };
    expect(body.error).toBe('DRAFT_CHANGED');
    expect(body.preview.willSend.message).toBe('something else entirely');
    expect(client.sendMessage).not.toHaveBeenCalled();
    await h.close();
  });

  it('a token never crosses tools', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_reinstate_event', { event_id: 'EV' });
    const res = await h.callTool('evite_cancel_event', { event_id: 'EV', confirmToken: p1.confirmToken });
    expect(res.isError).toBe(true);
    expect((parseToolResult(res) as { error: string }).error).toBe('TOKEN_INVALID');
    expect(client.cancelEvent).not.toHaveBeenCalled();
    await h.close();
  });

  it('a client that accepts the elicitation prompt writes in one call', async () => {
    const client = fakeClient();
    const elicitation = vi.fn(async () => ({ action: 'accept' as const, content: { confirmed: true } }));
    const h = await harnessFor(client, { elicitation });
    const res = await h.callTool('evite_send', { event_id: 'EVENTID0' });
    expect(res.isError).toBeFalsy();
    expect(elicitation).toHaveBeenCalled();
    expect(client.sendInvitation).toHaveBeenCalledTimes(1);
    expect(client.sendInvitation).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });

  it('a client that declines the elicitation prompt writes nothing', async () => {
    const client = fakeClient();
    const h = await harnessFor(client, { elicitation: async () => ({ action: 'decline' as const }) });
    await h.callTool('evite_send', { event_id: 'EVENTID0' });
    expect(client.sendInvitation).not.toHaveBeenCalled();
    await h.close();
  });

  it('MCP_CONFIRM_MODE=refuse refuses writes on a client that cannot be prompted', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_cancel_event', { event_id: 'EVENTID0' });
    const body = parseToolResult(res) as { reason: string; confirmToken?: string };
    expect(body.confirmToken).toBeUndefined();
    expect(body.reason).toBe('confirmation-unsupported');
    expect(client.cancelEvent).not.toHaveBeenCalled();
    await h.close();
  });
});
