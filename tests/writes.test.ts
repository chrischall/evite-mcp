import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
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
    createEvent: vi.fn(async () => ({ event: { id: 'NEW' } })),
    updateEvent: vi.fn(async () => ({ event: { id: 'EVENTID0' } })),
    addGuest: vi.fn(async () => ({ ok: true })),
    updateGuest: vi.fn(async () => ({ ok: true })),
    removeGuest: vi.fn(async () => ({ ok: true })),
    sendInvitation: vi.fn(async () => ({ ok: true })),
    cancelEvent: vi.fn(async () => ({ ok: true })),
    reinstateEvent: vi.fn(async () => ({ ok: true })),
    duplicateEvent: vi.fn(async () => ({ newEventId: 'NEW', customizeUrl: '/invitation/NEW/customize' })),
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
  };
}

async function harnessFor(client: EviteClient) {
  return createTestHarness((server) => registerWriteTools(server, client));
}

/** A fetch spy that MUST never be called in these tool tests. */
function guardFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('fetch must not be called in write-tool tests');
  });
}

afterEach(() => vi.restoreAllMocks());

describe('write tool registration', () => {
  it('registers the eleven write tools, all readOnlyHint:false', async () => {
    const h = await harnessFor(fakeClient());
    const tools = (await h.client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'evite_add_guest',
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
      ].sort(),
    );
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(false);
    }
    await h.close();
  });
});

describe('evite_rsvp', () => {
  it('without confirm: returns a preview and makes NO network/client call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_rsvp', {
      event_id: 'EVENTID0',
      guest_id: 'GUEST9',
      response: 'yes',
      number_of_adults: 2,
      number_of_kids: 1,
      note: 'see you there',
    });
    expect(client.rsvp).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/preview/i);
    expect(text).toContain('EVENTID0');
    expect(text).toContain('GUEST9');
    expect(text).toContain('yes');
    expect(text).toContain('confirm');
    await h.close();
  });

  it('with confirm: calls client.rsvp with the mapped fields', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_rsvp', {
      event_id: 'EVENTID0',
      guest_id: 'GUEST9',
      response: 'maybe',
      number_of_adults: 1,
      number_of_kids: 0,
      confirm: true,
    });
    expect(client.rsvp).toHaveBeenCalledWith('EVENTID0', 'GUEST9', {
      response: 'maybe',
      numberOfAdults: 1,
      numberOfKids: 0,
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
});

describe('evite_send_message', () => {
  it('without confirm: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_send_message', {
      event_id: 'EVENTID0',
      guest_id: 'GUEST9',
      message: 'hello all',
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/preview/i);
    expect(text).toContain('EVENTID0');
    expect(text).toContain('hello all');
    await h.close();
  });

  it('with confirm: calls client.sendMessage', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_send_message', {
      event_id: 'EVENTID0',
      guest_id: 'GUEST9',
      message: 'hello all',
      confirm: true,
    });
    expect(client.sendMessage).toHaveBeenCalledWith('EVENTID0', 'GUEST9', {
      message: 'hello all',
    });
    await h.close();
  });
});

describe('evite_create_event', () => {
  it('without confirm: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_create_event', {
      title: 'Pool Party',
      start_datetime: '2026-07-01T18:00:00',
      template_name: 'camp-confetti',
    });
    expect(client.createEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/preview/i);
    expect(text).toContain('Pool Party');
    // create returns a 500 even on success — the preview should warn about that
    expect(text).toMatch(/500/i);
    await h.close();
  });

  it('with confirm: calls client.createEvent with mapped input', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_create_event', {
      title: 'Pool Party',
      start_datetime: '2026-07-01T18:00:00',
      template_name: 'camp-confetti',
      message: 'come swim',
      confirm: true,
    });
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
  it('without confirm: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_update_event', {
      event_id: 'EVENTID0',
      title: 'Renamed',
    });
    expect(client.updateEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = res.content[0]!.text as string;
    expect(text).toMatch(/preview/i);
    expect(text).toContain('EVENTID0');
    expect(text).toContain('Renamed');
    await h.close();
  });

  it('with confirm: calls client.updateEvent with only the provided fields', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_update_event', {
      event_id: 'EVENTID0',
      title: 'Renamed',
      confirm: true,
    });
    expect(client.updateEvent).toHaveBeenCalledWith('EVENTID0', { title: 'Renamed' });
    await h.close();
  });

  it('requires at least one field to change', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_update_event', { event_id: 'EVENTID0', confirm: true });
    expect(res.isError).toBe(true);
    expect(client.updateEvent).not.toHaveBeenCalled();
    await h.close();
  });
});

describe('evite_add_guest', () => {
  const guests = [{ name: 'A', email: 'a@example.com' }];

  it('without confirm: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_add_guest', { event_id: 'EVENTID0', guests });
    expect(client.addGuest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0]!.text as string).toMatch(/preview/i);
    await h.close();
  });

  it('with confirm: calls client.addGuest with the guest list', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_add_guest', { event_id: 'EVENTID0', guests, confirm: true });
    expect(client.addGuest).toHaveBeenCalledWith('EVENTID0', guests);
    await h.close();
  });
});

describe('evite_update_guest / evite_remove_guest', () => {
  it('update without confirm: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_update_guest', {
      event_id: 'EVENTID0',
      guest_id: 'GUEST9',
      name: 'New',
      email: 'new@example.com',
    });
    expect(client.updateGuest).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0]!.text as string).toMatch(/preview/i);
    await h.close();
  });

  it('update with confirm: calls client.updateGuest', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_update_guest', {
      event_id: 'EVENTID0',
      guest_id: 'GUEST9',
      name: 'New',
      email: 'new@example.com',
      confirm: true,
    });
    expect(client.updateGuest).toHaveBeenCalledWith('EVENTID0', 'GUEST9', {
      name: 'New',
      email: 'new@example.com',
      phone: undefined,
    });
    await h.close();
  });

  it('remove with confirm: calls client.removeGuest', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_remove_guest', {
      event_id: 'EVENTID0',
      guest_id: 'GUEST9',
      confirm: true,
    });
    expect(client.removeGuest).toHaveBeenCalledWith('EVENTID0', 'GUEST9');
    await h.close();
  });
});

describe('evite_send', () => {
  it('without confirm: previews (warns it emails) and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_send', { event_id: 'EVENTID0' });
    expect(client.sendInvitation).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0]!.text as string).toMatch(/email/i);
    await h.close();
  });

  it('with confirm: calls client.sendInvitation', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_send', { event_id: 'EVENTID0', confirm: true });
    expect(client.sendInvitation).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });
});

describe('evite_cancel_event / evite_reinstate_event', () => {
  it('cancel without confirm: previews (warns destructive) and makes no call', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_cancel_event', { event_id: 'EVENTID0' });
    expect(client.cancelEvent).not.toHaveBeenCalled();
    expect(res.content[0]!.text as string).toMatch(/destructive/i);
    await h.close();
  });

  it('cancel with confirm: calls client.cancelEvent', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_cancel_event', { event_id: 'EVENTID0', confirm: true });
    expect(client.cancelEvent).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });

  it('reinstate with confirm: calls client.reinstateEvent', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_reinstate_event', { event_id: 'EVENTID0', confirm: true });
    expect(client.reinstateEvent).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });
});

describe('evite_duplicate_event', () => {
  it('without confirm: previews and makes no call', async () => {
    const fetchSpy = guardFetch();
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_duplicate_event', { event_id: 'EVENTID0' });
    expect(client.duplicateEvent).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.content[0]!.text as string).toMatch(/preview/i);
    await h.close();
  });

  it('with confirm: calls client.duplicateEvent', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_duplicate_event', { event_id: 'EVENTID0', confirm: true });
    expect(client.duplicateEvent).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });
});
