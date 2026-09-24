import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult, type TestHarnessOptions } from '@chrischall/mcp-utils/test';
import type { EviteClient } from '../src/client.js';
import { registerWriteTools } from '../src/tools/writes.js';

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
    createEvent: vi.fn(async () => ({ event: { id: 'NEW' } })),
    updateEvent: vi.fn(async () => ({ event: { id: 'EVENTID0' } })),
    addGuest: vi.fn(async () => ({ ok: true })),
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
    updateGuest: ReturnType<typeof vi.fn>;
    removeGuest: ReturnType<typeof vi.fn>;
    sendInvitation: ReturnType<typeof vi.fn>;
    cancelEvent: ReturnType<typeof vi.fn>;
    reinstateEvent: ReturnType<typeof vi.fn>;
    duplicateEvent: ReturnType<typeof vi.fn>;
    broadcast: ReturnType<typeof vi.fn>;
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
  preview: { wouldSend: Record<string, unknown>; caveat?: string };
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
    }
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
    expect(p1.preview.wouldSend).toEqual(args);
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
    expect(p1.preview.wouldSend).toEqual(args);
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
    expect(p1.preview.wouldSend).toEqual(args);
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

describe('evite_upload_photo', () => {
  it('phase 1: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_upload_photo', {
      event_id: 'EVENTID0',
      guest_id: 'GUEST9',
      path: '~/Pictures/cake.jpg',
    });
    expect(client.uploadPhoto).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.wouldSend.path).toBe('~/Pictures/cake.jpg');
    await h.close();
  });

  it('preview shows the resolved absolute path and the file size', async () => {
    guardFetch();
    const dir = mkdtempSync(join(tmpdir(), 'evite-preview-'));
    const file = join(dir, 'cake.png');
    writeFileSync(file, Buffer.alloc(1234));
    try {
      const h = await harnessFor(fakeClient());
      const p1 = await phaseOne(h, 'evite_upload_photo', { event_id: 'E', guest_id: 'G', path: file });
      expect(p1.preview.wouldSend.resolved_path).toBe(file);
      expect(p1.preview.wouldSend.size_bytes).toBe(1234);
      // A ~ path resolves against the home directory; a missing file has no size.
      const p2 = await phaseOne(h, 'evite_upload_photo', {
        event_id: 'E',
        guest_id: 'G',
        path: '~/evite-mcp-no-such-file.png',
      });
      expect(p2.preview.wouldSend.resolved_path).toBe(join(homedir(), 'evite-mcp-no-such-file.png'));
      expect(p2.preview.wouldSend.size_bytes).toBeUndefined();
      await h.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses the token when the file changed between preview and upload (DRAFT_CHANGED)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evite-preview-'));
    const file = join(dir, 'cake.png');
    writeFileSync(file, Buffer.alloc(10));
    try {
      const client = fakeClient();
      const h = await harnessFor(client);
      const args = { event_id: 'E', guest_id: 'G', path: file };
      const p1 = await phaseOne(h, 'evite_upload_photo', args);
      writeFileSync(file, Buffer.alloc(20));
      const res = await h.callTool('evite_upload_photo', { ...args, confirmToken: p1.confirmToken });
      expect(res.isError).toBe(true);
      expect((parseToolResult(res) as { error: string }).error).toBe('DRAFT_CHANGED');
      expect(client.uploadPhoto).not.toHaveBeenCalled();
      await h.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('phase 2: calls client.uploadPhoto once with path + guestId', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_upload_photo', {
      event_id: 'EVENTID0',
      guest_id: 'GUEST9',
      path: '~/Pictures/cake.jpg',
    });
    expect(client.uploadPhoto).toHaveBeenCalledTimes(1);
    expect(client.uploadPhoto).toHaveBeenCalledWith('EVENTID0', {
      path: '~/Pictures/cake.jpg',
      guestId: 'GUEST9',
      mimetype: undefined,
    });
    await h.close();
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
    expect(p1.preview.wouldSend).toEqual(args);
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
    expect(p1.preview.wouldSend).toEqual({ event_id: 'EVENTID0', patch: { title: 'Renamed' } });
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
    expect(p1.preview.wouldSend).toEqual({ event_id: 'EVENTID0', guests });
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

  it('phase 1: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const p1 = await phaseOne(h, 'evite_update_guest', args);
    expect(client.updateGuest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p1.preview.wouldSend).toEqual(args);
    await h.close();
  });

  it('phase 2: calls client.updateGuest once', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await confirmed(h, 'evite_update_guest', args);
    expect(client.updateGuest).toHaveBeenCalledTimes(1);
    expect(client.updateGuest).toHaveBeenCalledWith('EVENTID0', 'GUEST9', {
      name: 'New',
      email: 'new@example.com',
      phone: undefined,
    });
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
    expect(p1.preview.wouldSend).toEqual({ event_id: 'EV', guest_id: 'G' });
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
    expect(p1.preview.wouldSend).toEqual({ event_id: 'EVENTID0' });
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
    expect(p1.preview.wouldSend).toEqual({ event_id: 'EV' });
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
    expect(p1.preview.wouldSend).toEqual({ event_id: 'EVENTID0' });
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
    expect(body.preview.wouldSend.message).toBe('something else entirely');
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
