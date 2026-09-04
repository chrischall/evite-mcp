import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import type { EviteClient } from '../src/client.js';
import { registerEventTools } from '../src/tools/events.js';
import { registerGuestTools } from '../src/tools/guests.js';
import { registerMessageTools } from '../src/tools/messages.js';

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string): { response: any } =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const eventsList = loadFixture('events-list.json').response;
const eventDetail = loadFixture('event-detail.json').response;
const eventGuests = loadFixture('event-guests.json').response;
const eventPosts = loadFixture('event-posts.json').response;

/** A fake EviteClient whose read methods return fixture data + record calls. */
function fakeClient() {
  return {
    listEvents: vi.fn(async () => eventsList),
    getEvent: vi.fn(async () => eventDetail),
    listGuests: vi.fn(async () => eventGuests),
    rsvpSummary: vi.fn(async () => eventGuests.summary),
    listMessages: vi.fn(async () => eventPosts),
    listTemplates: vi.fn(async () => ({
      category: 'party',
      count: 1,
      templates: [{ templateName: 'camp-confetti_vanilla_kids', displayName: 'Camp Confetti' }],
    })),
  } as unknown as EviteClient & {
    listEvents: ReturnType<typeof vi.fn>;
    getEvent: ReturnType<typeof vi.fn>;
    listGuests: ReturnType<typeof vi.fn>;
    rsvpSummary: ReturnType<typeof vi.fn>;
    listMessages: ReturnType<typeof vi.fn>;
    listTemplates: ReturnType<typeof vi.fn>;
  };
}

/** Register all read tools against a fresh harness with the given client. */
async function harnessFor(client: EviteClient) {
  return createTestHarness((server) => {
    registerEventTools(server, client);
    registerGuestTools(server, client);
    registerMessageTools(server, client);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('tool registration', () => {
  it('registers all six read tools', async () => {
    const h = await harnessFor(fakeClient());
    const names = (await h.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'evite_get_event',
        'evite_list_events',
        'evite_list_guests',
        'evite_list_messages',
        'evite_list_templates',
        'evite_rsvp_summary',
      ].sort(),
    );
    await h.close();
  });

  it('evite_list_templates passes category + free_only through', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_list_templates', { category: 'party', free_only: true });
    expect(client.listTemplates).toHaveBeenCalledWith('party', true);
    await h.close();
  });
});

describe('evite_list_events', () => {
  it('strips the rendered card image by DEFAULT, keeping everything else', async () => {
    // `rendered_image_url` is a .png a model cannot see. Everything else on
    // the event — 26 other fields — survives, because nothing here knows which
    // of Evite's fields matter and compact does not guess.
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_list_events', {});
    const data = parseToolResult<{ events: Record<string, unknown>[] }>(res);
    expect(data.events[0]).not.toHaveProperty('rendered_image_url');
    const { rendered_image_url: _drop, ...rest } = eventsList.events[0] as Record<string, unknown>;
    expect(data.events[0]).toEqual(rest);
  });

  it('returns events + totals and defaults filterBy=all, status=[upcoming,past]', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    // `view: 'full'` — this assertion is about the payload round-tripping
    // whole. The default rung strips `rendered_image_url` (a .png), which the
    // compact test below covers.
    const res = await h.callTool('evite_list_events', { view: 'full' });
    const data = parseToolResult<typeof eventsList>(res);
    expect(data.events).toEqual(eventsList.events);
    expect(data.totals).toEqual(eventsList.totals);
    expect(client.listEvents).toHaveBeenCalledWith({
      filterBy: 'all',
      status: ['upcoming', 'past'],
      offset: undefined,
      numResults: undefined,
      filter: undefined,
    });
    await h.close();
  });

  it('forwards explicit filterBy, status, offset, numResults, filter', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    await h.callTool('evite_list_events', {
      filterBy: 'others',
      status: ['past'],
      offset: 10,
      numResults: 5,
      filter: 'pool',
    });
    expect(client.listEvents).toHaveBeenCalledWith({
      filterBy: 'others',
      status: ['past'],
      offset: 10,
      numResults: 5,
      filter: 'pool',
    });
    await h.close();
  });

  it('rejects an out-of-enum filterBy', async () => {
    const h = await harnessFor(fakeClient());
    const res = await h.callTool('evite_list_events', { filterBy: 'bogus' });
    expect(res.isError).toBe(true);
    await h.close();
  });
});

// `view` is ours. It selects a response shape on the way OUT and means nothing
// to Evite, so it must never appear in anything the client sends. The handlers
// used to be protected by accident — they re-parsed their arguments through a
// schema that did not contain `view`, so the key was stripped before it could
// reach a request. Now that they read the SDK-validated object directly, the
// protection has to be a deliberate one: name the fields you forward, and pin
// it here.
describe('view never reaches Evite', () => {
  it('is absent from every read tool\'s upstream call, on every rung', async () => {
    for (const rung of ['compact', 'full', undefined]) {
      const client = fakeClient();
      const h = await harnessFor(client);
      const view = rung === undefined ? {} : { view: rung };

      await h.callTool('evite_list_events', { ...view });
      await h.callTool('evite_get_event', { event_id: 'e1', ...view });
      await h.callTool('evite_list_templates', { category: 'party', ...view });
      await h.callTool('evite_list_guests', { event_id: 'e1', ...view });
      await h.callTool('evite_rsvp_summary', { event_id: 'e1', ...view });
      await h.callTool('evite_list_messages', { event_id: 'e1', ...view });

      const forwarded = [
        client.listEvents,
        client.getEvent,
        client.listTemplates,
        client.listGuests,
        client.rsvpSummary,
        client.listMessages,
      ].flatMap((fn) => fn.mock.calls);
      expect(forwarded.length).toBeGreaterThan(0);
      expect(JSON.stringify(forwarded)).not.toContain('view');
      await h.close();
    }
  });
});

describe('evite_get_event', () => {
  it('returns event detail for the given event_id', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_get_event', { event_id: 'EVENTID0' });
    expect(parseToolResult(res)).toEqual(eventDetail);
    expect(client.getEvent).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });

  it('requires event_id', async () => {
    const h = await harnessFor(fakeClient());
    const res = await h.callTool('evite_get_event', {});
    expect(res.isError).toBe(true);
    await h.close();
  });
});

describe('evite_list_guests', () => {
  it('returns the guests list for the event', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    // `full`: this assertion is about the guests list round-tripping whole.
    const res = await h.callTool('evite_list_guests', { event_id: 'EVENTID0', view: 'full' });
    const data = parseToolResult<typeof eventGuests>(res);
    expect(data.guests).toEqual(eventGuests.guests);
    expect(client.listGuests).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });
});

describe('evite_rsvp_summary', () => {
  it('returns just the RSVP summary', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_rsvp_summary', { event_id: 'EVENTID0' });
    expect(parseToolResult(res)).toEqual(eventGuests.summary);
    expect(client.rsvpSummary).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });
});

describe('evite_list_messages', () => {
  it('returns the posts thread', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_list_messages', { event_id: 'EVENTID0' });
    const data = parseToolResult<typeof eventPosts>(res);
    expect(data.posts).toEqual(eventPosts.posts);
    expect(client.listMessages).toHaveBeenCalledWith('EVENTID0');
    await h.close();
  });
});

describe('annotations', () => {
  it('marks every read tool readOnlyHint:true', async () => {
    const h = await harnessFor(fakeClient());
    const tools = await h.client.listTools();
    for (const t of tools.tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    await h.close();
  });
});
