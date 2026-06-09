import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EviteClient } from '../src/client.js';
import { SessionNotAuthenticatedError } from '@chrischall/mcp-utils';

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name: string): { response: unknown } =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const eventsList = loadFixture('events-list.json').response as {
  events: unknown[];
  totals: Record<string, number>;
};
const eventDetail = loadFixture('event-detail.json').response;
const eventGuests = loadFixture('event-guests.json').response as {
  guests: unknown[];
  summary: Record<string, unknown>;
};
const eventPosts = loadFixture('event-posts.json').response as { posts: unknown[] };

/** Stub `fetch` with a queue of responses. Returns the spy. */
function mockFetch(...responses: Array<{ status?: number; body?: unknown; rawBody?: string }>) {
  let i = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const body = r.rawBody ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    return new Response(body, { status: r.status ?? 200 }) as unknown as Response;
  });
}

/** A client wired to a fixed, injected session (no resolver / no bootstrap). */
const fakeSession = { cookieHeader: 'x-evite-session=s; evtsession=e' };
const newClient = () =>
  new EviteClient({ resolveSession: async () => fakeSession });

afterEach(() => vi.restoreAllMocks());

describe('EviteClient — listEvents', () => {
  it('GETs /services/events/v1/ with the cookie header and repeatable status params', async () => {
    const fetchSpy = mockFetch({ body: eventsList });
    const client = newClient();
    const result = await client.listEvents({ filterBy: 'all', status: ['upcoming', 'past'] });

    expect(result.events).toEqual(eventsList.events);
    expect(result.totals).toEqual(eventsList.totals);

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url.startsWith('https://www.evite.com/services/events/v1/?')).toBe(true);
    expect(url).toContain('filterBy=all');
    expect(url).toContain('type=invitation');
    // status is repeatable, not comma-joined:
    expect(url).toContain('status=upcoming');
    expect(url).toContain('status=past');
    expect(url).not.toContain('status=upcoming%2Cpast');

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe('x-evite-session=s; evtsession=e');
  });

  it('omits empty optional params and defaults type=invitation', async () => {
    const fetchSpy = mockFetch({ body: eventsList });
    const client = newClient();
    await client.listEvents({ filterBy: 'host', status: ['past'] });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('type=invitation');
    expect(url).not.toContain('offset=');
    expect(url).not.toContain('numResults=');
    expect(url).not.toContain('filter=');
  });

  it('passes through offset, numResults, and filter when provided', async () => {
    const fetchSpy = mockFetch({ body: eventsList });
    const client = newClient();
    await client.listEvents({ filterBy: 'all', status: ['past'], offset: 10, numResults: 5, filter: 'pool' });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('offset=10');
    expect(url).toContain('numResults=5');
    expect(url).toContain('filter=pool');
  });

  it('resolves the session lazily — only on the first call', async () => {
    mockFetch({ body: eventsList }, { body: eventsList });
    const resolver = vi.fn(async () => fakeSession);
    const client = new EviteClient({ resolveSession: resolver });
    expect(resolver).not.toHaveBeenCalled();
    await client.listEvents({ filterBy: 'all', status: ['past'] });
    await client.listEvents({ filterBy: 'all', status: ['past'] });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent first calls onto a single session resolution', async () => {
    mockFetch({ body: eventsList }, { body: eventsList });
    let release: ((s: typeof fakeSession) => void) | undefined;
    const resolver = vi.fn(
      () =>
        new Promise<typeof fakeSession>((res) => {
          release = res;
        }),
    );
    const client = new EviteClient({ resolveSession: resolver });
    const p1 = client.listEvents({ filterBy: 'all', status: ['past'] });
    const p2 = client.listEvents({ filterBy: 'all', status: ['past'] });
    release!(fakeSession);
    await Promise.all([p1, p2]);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('retries session resolution after a transient failure instead of caching the rejection', async () => {
    mockFetch({ body: eventsList });
    const resolver = vi
      .fn<() => Promise<typeof fakeSession>>()
      .mockRejectedValueOnce(new Error('transient network blip'))
      .mockResolvedValueOnce(fakeSession);
    const client = new EviteClient({ resolveSession: resolver });

    await expect(client.listEvents({ filterBy: 'all', status: ['past'] })).rejects.toThrow(
      'transient network blip',
    );

    // Second call must invoke the resolver again — not rethrow the cached rejection.
    const result = await client.listEvents({ filterBy: 'all', status: ['past'] });
    expect(result.events).toEqual(eventsList.events);
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

describe('EviteClient — single-event sub-resources', () => {
  it('getEvent hits /services/event/v1/{id} (singular)', async () => {
    const fetchSpy = mockFetch({ body: eventDetail });
    const client = newClient();
    const result = await client.getEvent('EVENTID0');
    expect(result).toEqual(eventDetail);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe('https://www.evite.com/services/event/v1/EVENTID0');
  });

  it('listGuests hits /services/event/v1/{id}/guests/ and returns {guests,summary}', async () => {
    const fetchSpy = mockFetch({ body: eventGuests });
    const client = newClient();
    const result = await client.listGuests('EVENTID0');
    expect(result.guests).toEqual(eventGuests.guests);
    expect(result.summary).toEqual(eventGuests.summary);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe('https://www.evite.com/services/event/v1/EVENTID0/guests/');
  });

  it('rsvpSummary returns just the summary slice of listGuests', async () => {
    mockFetch({ body: eventGuests });
    const client = newClient();
    const summary = await client.rsvpSummary('EVENTID0');
    expect(summary).toEqual(eventGuests.summary);
  });

  it('listMessages hits /services/event/v1/{id}/posts/', async () => {
    const fetchSpy = mockFetch({ body: eventPosts });
    const client = newClient();
    const result = await client.listMessages('EVENTID0');
    expect(result.posts).toEqual(eventPosts.posts);
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe('https://www.evite.com/services/event/v1/EVENTID0/posts/');
  });
});

describe('EviteClient — error handling', () => {
  it('maps 401 to SessionNotAuthenticatedError', async () => {
    mockFetch({ status: 401, rawBody: '' });
    const client = newClient();
    await expect(client.listEvents({ filterBy: 'all', status: ['past'] })).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError,
    );
  });

  it('maps 403 to SessionNotAuthenticatedError too', async () => {
    mockFetch({ status: 403, rawBody: '' });
    const client = newClient();
    await expect(client.getEvent('X')).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
  });

  it('runs a non-2xx body through truncation/redaction (no token leakage)', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.s3cr3tSignaturePart';
    const leaky = `upstream error Bearer abcdef0123456789 with ${jwt} stuff`;
    mockFetch({ status: 500, rawBody: leaky });
    const client = newClient();
    let caught: unknown;
    try {
      await client.getEvent('X');
    } catch (e) {
      caught = e;
    }
    const msg = (caught as Error).message;
    expect(msg).toContain('500');
    expect(msg).not.toContain('abcdef0123456789');
    expect(msg).not.toContain(jwt);
    expect(msg).toContain('[REDACTED]');
  });

  it('surfaces a 404 with the path but no body leakage', async () => {
    mockFetch({ status: 404, rawBody: 'not found' });
    const client = newClient();
    await expect(client.getEvent('MISSING')).rejects.toThrow(/404/);
  });

  it('tolerates a non-2xx whose body read fails (no body in the error)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return {
        status: 500,
        ok: false,
        text: async () => {
          throw new Error('stream broke');
        },
      } as unknown as Response;
    });
    const client = newClient();
    await expect(client.getEvent('X')).rejects.toThrow(/Evite error 500/);
  });
});

describe('EviteClient — health', () => {
  it('reports unresolved before the first call', () => {
    const client = newClient();
    const h = client.health();
    expect(h.ok).toBe(true);
    expect(h.authMode).toBe('unresolved');
  });

  it('reports resolved after a successful call', async () => {
    mockFetch({ body: eventsList });
    const client = newClient();
    await client.listEvents({ filterBy: 'all', status: ['past'] });
    expect(client.health().authMode).toBe('resolved');
  });

  it('constructs with the default resolver when no options are passed', () => {
    const client = new EviteClient();
    expect(client.health().authMode).toBe('unresolved');
  });
});

describe('EviteClient — listTemplates', () => {
  const galleryHtml = `
    <a href="/invitation/camp-confetti_vanilla_kids/create">x</a>
    <a href="/invitation/balloon-bash_blue_bday/preview">y</a>
    <a href="/invitation/camp-confetti_vanilla_kids/create">dup</a>
    <a href="/somewhere/else/">z</a>`;

  it('GETs the gallery category page and parses unique slugs + display names', async () => {
    const spy = mockFetch({ rawBody: galleryHtml });
    const client = newClient();
    const res = await client.listTemplates('birthday/kids-teens/kids-birthday');

    expect(spy.mock.calls[0]![0]).toBe(
      'https://www.evite.com/invites/birthday/kids-teens/kids-birthday/',
    );
    expect(res.count).toBe(2); // deduped
    expect(res.templates).toEqual([
      { templateName: 'camp-confetti_vanilla_kids', displayName: 'Camp Confetti' },
      { templateName: 'balloon-bash_blue_bday', displayName: 'Balloon Bash' },
    ]);
  });

  it('appends the free filter when free_only is set', async () => {
    const spy = mockFetch({ rawBody: galleryHtml });
    const client = newClient();
    await client.listTemplates('party', true);
    expect(spy.mock.calls[0]![0]).toBe(
      'https://www.evite.com/invites/party/?active_filter=free_premium%2Cfree',
    );
  });
});

describe('EviteClient — getHtml / write error paths', () => {
  it('maps a 401 on an HTML scrape (listTemplates) to SessionNotAuthenticatedError', async () => {
    mockFetch({ status: 401, rawBody: '' });
    await expect(newClient().listTemplates('party')).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
  });

  it('surfaces a non-2xx HTML-scrape failure with the path', async () => {
    mockFetch({ status: 500, rawBody: 'oops' });
    await expect(newClient().listTemplates('party')).rejects.toThrow(/Evite error 500/);
  });

  it('tolerates an unreadable HTML-scrape error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      ({ status: 500, ok: false, text: async () => { throw new Error('broke'); } } as unknown as Response));
    await expect(newClient().listTemplates('party')).rejects.toThrow(/Evite error 500/);
  });

  it('surfaces a non-2xx write failure via the shared formatter', async () => {
    mockFetch({ status: 500, rawBody: 'server error' });
    await expect(newClient().rsvp('EV', 'G', { response: 'yes' })).rejects.toThrow(/Evite error 500/);
  });

  it('tolerates an unreadable write error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      ({ status: 500, ok: false, text: async () => { throw new Error('broke'); } } as unknown as Response));
    await expect(newClient().rsvp('E', 'G', { response: 'yes' })).rejects.toThrow(/Evite error 500/);
  });
});
