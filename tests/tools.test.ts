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
  it('returns events + totals and defaults filterBy=all, status=[upcoming,past]', async () => {
    const client = fakeClient();
    const h = await harnessFor(client);
    const res = await h.callTool('evite_list_events', {});
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
    const res = await h.callTool('evite_list_guests', { event_id: 'EVENTID0' });
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
