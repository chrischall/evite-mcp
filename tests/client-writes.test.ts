import { describe, it, expect, vi, afterEach } from 'vitest';
import { EviteClient, CSRF_HEADER } from '../src/client.js';
import { SessionNotAuthenticatedError } from '@chrischall/mcp-utils';

/**
 * Stub `fetch` with a queue of responses. Returns the spy.
 *
 * SAFETY: every write test runs against this stub — no real Evite mutation
 * ever leaves the process. The exact write payloads are UNVERIFIED (see
 * issue #3); these tests pin the request SHAPE, not a captured-from-live body.
 */
function mockFetch(...responses: Array<{ status?: number; body?: unknown; rawBody?: string }>) {
  let i = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const body = r.rawBody ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    return new Response(body, { status: r.status ?? 200 }) as unknown as Response;
  });
}

/** A session that carries a CSRF token (writes need it). */
const fakeSession = {
  cookieHeader: 'x-evite-session=s; evtsession=e; csrftoken=tok123',
  csrfToken: 'tok123',
};
const newClient = (session = fakeSession) =>
  new EviteClient({ resolveSession: async () => session });

/** Read back the parsed JSON body of the Nth fetch call. */
function bodyOf(spy: ReturnType<typeof mockFetch>, n = 0): Record<string, unknown> {
  const init = spy.mock.calls[n]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}
function headersOf(spy: ReturnType<typeof mockFetch>, n = 0): Record<string, string> {
  const init = spy.mock.calls[n]![1] as RequestInit;
  return init.headers as Record<string, string>;
}

afterEach(() => vi.restoreAllMocks());

describe('EviteClient — rsvp', () => {
  it('PUTs the guest resource with the CSRF header and rsvp fields', async () => {
    const spy = mockFetch({ body: { ok: true } });
    const client = newClient();
    await client.rsvp('EVENTID0', 'GUEST9', {
      response: 'yes',
      numberOfAdults: 2,
      numberOfKids: 1,
      note: 'see you there',
    });

    const url = spy.mock.calls[0]![0] as string;
    const init = spy.mock.calls[0]![1] as RequestInit;
    // Verified live: PUT /services/event/v1/{id}/guests/{guestId} → 200.
    expect(url).toBe('https://www.evite.com/services/event/v1/EVENTID0/guests/GUEST9');
    expect(init.method).toBe('PUT');

    const headers = headersOf(spy);
    expect(headers.cookie).toBe(fakeSession.cookieHeader);
    expect(headers[CSRF_HEADER]).toBe('tok123');
    expect(headers['content-type']).toBe('application/json');

    const body = bodyOf(spy);
    expect(body.rsvpResponse).toBe('yes');
    expect(body.numberOfAdults).toBe(2);
    expect(body.numberOfKids).toBe(1);
    expect(body.comments).toBe('see you there');
  });

  it('omits the note when not provided', async () => {
    const spy = mockFetch({ body: { ok: true } });
    const client = newClient();
    await client.rsvp('E', 'G', { response: 'no', numberOfAdults: 0, numberOfKids: 0 });
    const body = bodyOf(spy);
    expect('comments' in body).toBe(false);
    expect(body.rsvpResponse).toBe('no');
  });

  it('maps 401 to SessionNotAuthenticatedError', async () => {
    mockFetch({ status: 401, rawBody: '' });
    const client = newClient();
    await expect(
      client.rsvp('E', 'G', { response: 'yes', numberOfAdults: 1, numberOfKids: 0 }),
    ).rejects.toBeInstanceOf(SessionNotAuthenticatedError);
  });
});

describe('EviteClient — sendMessage (VERIFIED endpoint)', () => {
  it('POSTs the /tsunami/ per-guest messages endpoint with the message', async () => {
    const spy = mockFetch({ body: { ok: true } });
    const client = newClient();
    await client.sendMessage('EVENTID0', 'GUEST9', { message: 'hello all' });

    const url = spy.mock.calls[0]![0] as string;
    const init = spy.mock.calls[0]![1] as RequestInit;
    // Verified live: host "Send message" hits the /tsunami/ messaging service per guest.
    expect(url).toBe(
      'https://www.evite.com/tsunami/v1/services/event/EVENTID0/guest/GUEST9/messages',
    );
    expect(init.method).toBe('POST');
    expect(headersOf(spy)[CSRF_HEADER]).toBe('tok123');
    expect(bodyOf(spy).message).toBe('hello all');
  });
});

describe('EviteClient — createEvent', () => {
  it('POSTs /services/event/v1/ with the input nested under `event`', async () => {
    const spy = mockFetch({ body: { event: { id: 'NEW' } } });
    const client = newClient();
    await client.createEvent({
      title: 'Pool Party',
      startDatetime: '2026-07-01T18:00:00',
      templateName: 'camp-confetti',
    });

    const url = spy.mock.calls[0]![0] as string;
    const init = spy.mock.calls[0]![1] as RequestInit;
    // Verified live: POST /services/event/v1/ with the fields wrapped in `event`.
    expect(url).toBe('https://www.evite.com/services/event/v1/');
    expect(init.method).toBe('POST');
    expect(headersOf(spy)[CSRF_HEADER]).toBe('tok123');
    expect(bodyOf(spy)).toEqual({
      event: { title: 'Pool Party', startDatetime: '2026-07-01T18:00:00', templateName: 'camp-confetti' },
    });
  });
});

describe('EviteClient — updateEvent (VERIFIED endpoint)', () => {
  it('PATCHes /services/event/v1/{id} with the patch nested under `event`', async () => {
    const spy = mockFetch({ body: { event: { id: 'EVENTID0' } } });
    const client = newClient();
    await client.updateEvent('EVENTID0', { title: 'Renamed' });

    const url = spy.mock.calls[0]![0] as string;
    const init = spy.mock.calls[0]![1] as RequestInit;
    // Verified live: PATCH with {event:{...}} changed the title; PUT/bare body did not.
    expect(url).toBe('https://www.evite.com/services/event/v1/EVENTID0');
    expect(init.method).toBe('PATCH');
    expect(headersOf(spy)[CSRF_HEADER]).toBe('tok123');
    expect(bodyOf(spy)).toEqual({ event: { title: 'Renamed' } });
  });
});

describe('EviteClient — cancelEvent (VERIFIED endpoint)', () => {
  it('POSTs the /actions/cancel/ sub-path with an empty body + CSRF header', async () => {
    const spy = mockFetch({ body: { ok: true } });
    const client = newClient();
    await client.cancelEvent('EVENTID0');

    const url = spy.mock.calls[0]![0] as string;
    const init = spy.mock.calls[0]![1] as RequestInit;
    // Confirmed live: POST /services/event/v1/{id}/actions/cancel/ → 202.
    expect(url).toBe('https://www.evite.com/services/event/v1/EVENTID0/actions/cancel/');
    expect(init.method).toBe('POST');
    expect(headersOf(spy)[CSRF_HEADER]).toBe('tok123');
    expect(bodyOf(spy)).toEqual({});
  });

  it('treats 202 Accepted as success (the status the action returns)', async () => {
    const spy = mockFetch({ status: 202, rawBody: '' });
    const client = newClient();
    await expect(client.cancelEvent('EVENTID0')).resolves.toEqual({});
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('EviteClient — reinstateEvent (VERIFIED endpoint)', () => {
  it('POSTs the /actions/reinstate/ sub-path with an empty body + CSRF header', async () => {
    const spy = mockFetch({ status: 202, rawBody: '' });
    const client = newClient();
    await client.reinstateEvent('EVENTID0');

    const url = spy.mock.calls[0]![0] as string;
    const init = spy.mock.calls[0]![1] as RequestInit;
    // Confirmed live: POST /services/event/v1/{id}/actions/reinstate/ → 202.
    expect(url).toBe('https://www.evite.com/services/event/v1/EVENTID0/actions/reinstate/');
    expect(init.method).toBe('POST');
    expect(headersOf(spy)[CSRF_HEADER]).toBe('tok123');
    expect(bodyOf(spy)).toEqual({});
  });
});

describe('EviteClient — CSRF presence', () => {
  it('sends the CSRF header on every write (centralized in one place)', async () => {
    const spy = mockFetch({ body: {} }, { body: {} }, { body: {} }, { body: {} });
    const client = newClient();
    await client.rsvp('E', 'G', { response: 'maybe', numberOfAdults: 1, numberOfKids: 0 });
    await client.sendMessage('E', 'G', { message: 'x' });
    await client.createEvent({ title: 't', startDatetime: 's', templateName: 'tpl' });
    await client.updateEvent('E', { title: 't' });
    for (let n = 0; n < 4; n++) {
      expect(headersOf(spy, n)[CSRF_HEADER]).toBe('tok123');
    }
  });

  it('still sends the write when no CSRF token resolved (header simply absent)', async () => {
    const spy = mockFetch({ body: {} });
    const client = newClient({ cookieHeader: 'x-evite-session=s; evtsession=e' });
    await client.sendMessage('E', 'G', { message: 'x' });
    const headers = headersOf(spy);
    expect(headers[CSRF_HEADER]).toBeUndefined();
    expect(headers.cookie).toBe('x-evite-session=s; evtsession=e');
  });
});
