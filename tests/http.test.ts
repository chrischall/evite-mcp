import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpToolError, WriteOutcomeUnknownError, withCallSignal } from '@chrischall/mcp-utils';
import { eviteFetch, REQUEST_TIMEOUT_MS, WRITE_OUTCOME_HINT } from '../src/http.js';

/** A fetch that never answers until its signal aborts — a stalled upstream. */
function hangUntilAborted(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  });
}

afterEach(() => vi.restoreAllMocks());

describe('eviteFetch (fleet-audit #1188)', () => {
  it('defaults to a 30 s deadline', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('passes the response through and always sends a signal', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const res = await eviteFetch('https://www.evite.com/x', { method: 'GET' });
    expect(await res.text()).toBe('ok');
    expect((spy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('a stalled read times out instead of hanging', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(hangUntilAborted);
    const err = await eviteFetch('https://www.evite.com/x', { method: 'GET' }, { timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/Evite request timed out after 20ms/);
  });

  it('a read that drops names the host and the cause, chaining the fetch error (safe to retry)', async () => {
    const boom = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND www.evite.com'), { code: 'ENOTFOUND' }),
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(boom);
    const err = await eviteFetch('https://www.evite.com/x?token=secret', { method: 'GET' }).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err).not.toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.kind).toBe('transport');
    expect(err.message).toBe('Could not reach Evite at www.evite.com (ENOTFOUND: getaddrinfo ENOTFOUND www.evite.com).');
    expect(err.message).not.toContain('secret');
    expect(err.hint).toMatch(/DNS|VPN/);
    expect(err.cause).toBe(boom);
  });

  it('a read whose egress proxy refuses the host points at the allow-list', async () => {
    const aborted = Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', { cause: new Error('Request was cancelled.', { cause: aborted }) }),
    );
    const err = await eviteFetch('https://storage.googleapis.com/b/o', { method: 'GET' }, { service: 'Evite uploads' }).catch(
      (e) => e,
    );
    expect(err.message).toMatch(/^Could not reach Evite uploads at storage\.googleapis\.com/);
    expect(err.hint).toMatch(/egress allow-list/);
  });

  it('a read that fails any other way rethrows the error unchanged', async () => {
    const boom = new Error('boom');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(boom);
    await expect(eviteFetch('https://www.evite.com/x', { method: 'GET' })).rejects.toBe(boom);
  });

  it('a write that times out is reported as outcome-unknown with a check-first hint', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(hangUntilAborted);
    const err = await eviteFetch(
      'https://www.evite.com/tsunami/x',
      { method: 'POST', body: '{}' },
      { write: true, timeoutMs: 20 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.timedOut).toBe(true);
    expect(err.retrySafe).toBe(false);
    expect(err.message).toMatch(/POST to Evite timed out after 20ms/);
    expect(err.hint).toBe(WRITE_OUTCOME_HINT);
    expect(WRITE_OUTCOME_HINT).toMatch(/evite_list_messages/);
  });

  it('a write whose connection drops is outcome-unknown, naming the service', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const err = await eviteFetch('https://rtdb/x', { method: 'POST' }, { write: true, service: 'Evite chat' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.timedOut).toBe(false);
    expect(err.message).toMatch(/POST to Evite chat failed: fetch failed/);
  });

  it('a write with no method is reported as a GET (the duplicate-event copy route)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const err = await eviteFetch('https://www.evite.com/plus/create/1/copy/', {}, { write: true }).catch((e) => e);
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(err.message).toMatch(/^GET to Evite/);
  });

  it('aborts with the MCP call that asked for it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(hangUntilAborted);
    const controller = new AbortController();
    const pending = withCallSignal(controller.signal, () => eviteFetch('https://www.evite.com/x', { method: 'GET' }));
    controller.abort(new Error('client cancelled'));
    await expect(pending).rejects.toThrow(/client cancelled/);
  });

  it('cancellable:false ignores the MCP call signal (single-flight login) but keeps the deadline', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const controller = new AbortController();
    controller.abort(new Error('client cancelled'));
    await withCallSignal(controller.signal, () =>
      eviteFetch('https://www.evite.com/ajax_login', { method: 'POST' }, { cancellable: false }),
    );
    const signal = (spy.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);
  });

  it('uses an injected fetch implementation when given one', async () => {
    const impl = vi.fn(async () => new Response('injected'));
    const res = await eviteFetch('https://www.evite.com/x', { method: 'GET' }, { fetchImpl: impl as typeof fetch });
    expect(await res.text()).toBe('injected');
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
