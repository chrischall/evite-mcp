// fleet-audit #1188: every request the client makes is bounded and cancellable,
// and a write that gets no answer says its outcome is unknown.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WriteOutcomeUnknownError } from '@chrischall/mcp-utils';
import { EviteClient } from '../src/client.js';
import { loginWithPassword } from '../src/auth-login.js';

const fakeSession = {
  cookieHeader: 'x-evite-session=s; evtsession=e; csrftoken=tok123',
  csrfToken: 'tok123',
};
const newClient = () => new EviteClient({ resolveSession: async () => fakeSession });

/** Answer each fetch from the queue; once it runs out, reject like a dropped connection. */
function queue(...bodies: unknown[]) {
  let i = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (i >= bodies.length) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(bodies[i++]), { status: 200 });
  });
}

const signalOf = (spy: ReturnType<typeof queue>, n: number) =>
  (spy.mock.calls[n]![1] as RequestInit).signal;

afterEach(() => vi.restoreAllMocks());

describe('EviteClient transport', () => {
  it('reads carry a deadline signal', async () => {
    const spy = queue({ events: [] });
    await newClient().listEvents({});
    expect(signalOf(spy, 0)).toBeInstanceOf(AbortSignal);
  });

  it('a read whose connection drops stays a plain error (safe to retry)', async () => {
    queue();
    const err = await newClient().listEvents({}).catch((e) => e);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(String(err)).toMatch(/Could not reach Evite at www\.evite\.com/);
  });

  it('a broadcast whose connection drops is outcome-unknown, not a bare TypeError', async () => {
    const spy = queue();
    const err = await newClient()
      .broadcast('E1', { message: 'hi', groups: ['yes'] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.hint).toMatch(/evite_list_messages/);
    expect(signalOf(spy, 0)).toBeInstanceOf(AbortSignal);
  });

  it('a send whose connection drops is outcome-unknown', async () => {
    queue();
    await expect(newClient().sendInvitation('E1')).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('duplicate_event (a GET that creates a draft) is outcome-unknown on a dropped connection', async () => {
    queue();
    await expect(newClient().duplicateEvent('E1')).rejects.toBeInstanceOf(WriteOutcomeUnknownError);
  });

  it('the RTDB message push is outcome-unknown on a dropped connection; the token exchange is not a write', async () => {
    const GUESTS = {
      guests: [
        { guestId: 'HOSTGUEST', userId: 'HOSTUSER', name: 'Host', guestType: 'host' },
        { guestId: 'G9', userId: 'U9', name: 'Nine', guestType: 'guest' },
      ],
      summary: {},
    };
    const GRANT = {
      token: 't',
      readOnly: false,
      fire_config: { apiKey: 'K', databaseURL: 'https://fb.example/' },
      refs: { messages: '/m' },
    };
    const spy = queue(GUESTS, GRANT, { idToken: 'ID' });
    const err = await newClient().sendMessage('E1', 'G9', { message: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.message).toMatch(/Evite chat/);
    for (let n = 0; n < 4; n++) expect(signalOf(spy, n)).toBeInstanceOf(AbortSignal);

    vi.restoreAllMocks();
    queue(GUESTS, GRANT);
    const exchange = await newClient().sendMessage('E1', 'G9', { message: 'x' }).catch((e) => e);
    expect(exchange).not.toBeInstanceOf(WriteOutcomeUnknownError);
  });
});

describe('loginWithPassword transport', () => {
  it('both login requests carry a deadline signal', async () => {
    const impl = vi.fn(async () => new Response('', { status: 500 }));
    await loginWithPassword('a@example.com', 'pw', impl as unknown as typeof fetch).catch(() => undefined);
    expect(impl.mock.calls.length).toBeGreaterThan(0);
    for (const call of impl.mock.calls) {
      expect(((call as unknown[])[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  // eviteFetch's deadline fires as a DOMException named TimeoutError.
  const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

  it('a login that times out says so instead of blaming the password', async () => {
    const impl = vi.fn(async () => {
      throw timeoutError();
    });
    const err = await loginWithPassword('a@example.com', 'pw', impl as unknown as typeof fetch).catch((e) => e);
    expect(err.kind).toBe('timeout');
    expect(String(err.message)).not.toMatch(/password/i);
  });

  it('a login POST that times out says so too', async () => {
    let n = 0;
    const impl = vi.fn(async () => {
      if (n++ === 0) return new Response('', { status: 200, headers: { 'set-cookie': 'csrftoken=abc; Path=/' } });
      throw timeoutError();
    });
    const err = await loginWithPassword('a@example.com', 'pw', impl as unknown as typeof fetch).catch((e) => e);
    expect(impl).toHaveBeenCalledTimes(2);
    expect(err.kind).toBe('timeout');
  });
});
