import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { EviteClient } from '../src/client.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerEventTools, briefLine } from '../src/tools/events.js';
import { registerGuestTools } from '../src/tools/guests.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerWriteTools } from '../src/tools/writes.js';

/**
 * Context-group hints (`_meta.mint`, mcp-host spec 2026-11-03 D4): read off the
 * config each registrar hands `registerTool` (where the hints are authored) and,
 * separately, off `tools/list` (what a host sees).
 */
const REGISTRARS = [registerEventTools, registerGuestTools, registerMessageTools, registerWriteTools];

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

type Config = {
  _meta?: Record<string, unknown>;
  inputSchema?: { shape: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};

function registeredConfigs(): Map<string, Config> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const configs = new Map<string, Config>();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
    configs.set(name, config as Config);
    return undefined as never;
  });
  const client = {} as EviteClient;
  for (const register of REGISTRARS) register(server, client);
  return configs;
}

const mintOf = (c: Config | undefined) => c?._meta?.mint as Record<string, unknown>;

afterEach(() => vi.restoreAllMocks());

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  evite_list_events: 'whats-on',
  evite_get_event: 'lookup',
  evite_list_templates: 'lookup',
  evite_list_guests: 'lookup',
  evite_rsvp_summary: 'lookup',
  evite_list_messages: 'lookup',
  evite_rsvp: 'change',
  evite_send_message: 'send',
  evite_broadcast: 'send',
  evite_upload_photo: 'change',
  evite_create_event: 'change',
  evite_update_event: 'change',
  evite_add_guest: 'change',
  evite_update_guest: 'change',
  evite_remove_guest: 'change',
  evite_send: 'send',
  evite_cancel_event: 'change',
  evite_reinstate_event: 'change',
  evite_duplicate_event: 'change',
};

describe('_meta.mint on every registered tool', () => {
  it('names every tool registerTool was handed, so a new tool cannot skip the decision', () => {
    expect([...registeredConfigs().keys()].sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain family and intent %s', (name, intent) => {
    const mint = mintOf(registeredConfigs().get(name));
    expect(mint).toBeDefined();
    expect(mint.domain).toBe('family');
    expect(mint.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract', () => {
    for (const [name, config] of registeredConfigs()) {
      const mint = mintOf(config);
      const shape = config.inputSchema?.shape ?? {};
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), name).toEqual([]);
      expect(DOMAINS, name).toContain(mint.domain);
      expect(INTENTS, name).toContain(mint.intent);
      if ('canonical' in mint) {
        expect(mint.canonical, name).toBe(true);
        expect(config.annotations?.readOnlyHint, name).toBe(true);
        expect(['whats-new', 'whats-due', 'whats-on'], name).toContain(mint.intent);
      }
      if ('subject' in mint) expect(shape, name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, string>;
        expect(Object.keys(when).sort(), name).toEqual(['end', 'start']);
        expect(shape, name).toHaveProperty(when.start);
        expect(shape, name).toHaveProperty(when.end);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, name).toBeLessThanOrEqual(40);
          expect(a, name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('marks exactly one tool canonical: the events list, for whats-on (no subject, no range)', () => {
    const canonical = [...registeredConfigs()]
      .filter(([, c]) => mintOf(c).canonical === true)
      .map(([n, c]) => [n, mintOf(c).intent]);
    expect(canonical).toEqual([['evite_list_events', 'whats-on']]);
    const mint = mintOf(registeredConfigs().get('evite_list_events'));
    // Evite's list takes no date range and the MCP has no listable subjects
    // (children, properties): neither `when` nor `subject` is honest here.
    expect(mint).not.toHaveProperty('subject');
    expect(mint).not.toHaveProperty('when');
    expect(mint.aliases).toEqual(expect.arrayContaining(['party', 'evite']));
  });
});

describe('_meta.mint on tools/list', () => {
  it('reaches the wire for every tool except the healthcheck', async () => {
    const client = { health: () => ({}) } as unknown as EviteClient;
    const h = await createTestHarness((server) => {
      registerHealthcheckTools(server, client);
      for (const register of REGISTRARS) register(server, client);
    });
    const { tools } = await h.client.listTools();
    await h.close();
    const unhinted = tools.filter((t) => !(t._meta as Record<string, unknown> | undefined)?.mint).map((t) => t.name);
    expect(unhinted).toEqual(['evite_healthcheck']);
    const events = tools.find((t) => t.name === 'evite_list_events');
    expect((events?._meta as Record<string, unknown>).mint).toMatchObject({ canonical: true, intent: 'whats-on' });
    const view = (events?.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.view;
    expect(view.enum).toContain('brief');
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const eventsList = JSON.parse(readFileSync(join(here, 'fixtures', 'events-list.json'), 'utf8')).response;

function briefHarness(listEvents: ReturnType<typeof vi.fn>) {
  const client = { listEvents } as unknown as EviteClient;
  return createTestHarness((server) => registerEventTools(server, client));
}

function envelope(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content[0]!.text!;
  return JSON.parse(text) as { untrusted_content: boolean; note: string; data: string[] };
}

describe('evite_list_events view: brief', () => {
  it('answers one line per event inside the untrusted-data envelope', async () => {
    const listEvents = vi.fn(async () => eventsList);
    const h = await briefHarness(listEvents);
    const result = await h.callTool('evite_list_events', { view: 'brief' });
    await h.close();
    const env = envelope(result as never);
    expect(Object.keys(env).slice(0, 2)).toEqual(['untrusted_content', 'note']);
    expect(env.untrusted_content).toBe(true);
    expect(env.note).toMatch(/host/i);
    expect(env.data[0]).toBe('Sample Host Event — 2026-05-29T15:30:00.000Z — past, hosting');
    expect(env.data[1]).toBe('Sample Guest Event — 2026-05-15T18:00:00.000Z — past, rsvp maybe');
    for (const line of env.data) expect(line.length).toBeLessThanOrEqual(120);
  });

  it('asks for upcoming events only, with a bounded page, when status is not given', async () => {
    const listEvents = vi.fn(async () => ({ events: [], totals: {} }));
    const h = await briefHarness(listEvents);
    await h.callTool('evite_list_events', { view: 'brief' });
    await h.close();
    expect(listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['upcoming'], numResults: 25, filterBy: 'all' }),
    );
  });

  it('keeps the explicit status and the [upcoming, past] default on other rungs', async () => {
    const listEvents = vi.fn(async () => eventsList);
    const h = await briefHarness(listEvents);
    await h.callTool('evite_list_events', { view: 'brief', status: ['past'], numResults: 5 });
    await h.callTool('evite_list_events', {});
    await h.close();
    expect(listEvents.mock.calls[0]![0]).toMatchObject({ status: ['past'], numResults: 5 });
    expect(listEvents.mock.calls[1]![0]).toMatchObject({ status: ['upcoming', 'past'], numResults: undefined });
  });

  it('answers "-- none" for an empty result', async () => {
    const h = await briefHarness(vi.fn(async () => ({ events: [], totals: {} })));
    const env = envelope((await h.callTool('evite_list_events', { view: 'brief' })) as never);
    await h.close();
    expect(env.data).toEqual(['-- none']);
  });

  it('answers "-- none" when the payload carries no events array', async () => {
    const h = await briefHarness(vi.fn(async () => ({ totals: {} })));
    const env = envelope((await h.callTool('evite_list_events', { view: 'brief' })) as never);
    await h.close();
    expect(env.data).toEqual(['-- none']);
  });

  it('notes "-- more" when the page came back full', async () => {
    const two = { events: eventsList.events.slice(0, 2), totals: {} };
    const h = await briefHarness(vi.fn(async () => two));
    const env = envelope((await h.callTool('evite_list_events', { view: 'brief', numResults: 2 })) as never);
    await h.close();
    expect(env.data).toHaveLength(3);
    expect(env.data[2]).toBe('-- more');
  });
});

describe('briefLine', () => {
  it('shortens a long title to keep the line within 120 characters', () => {
    const line = briefLine({ title: 'x'.repeat(200), start: '2026-06-01T00:00:00Z', status: 'upcoming', is_host: true });
    expect(line.length).toBe(120);
    expect(line.endsWith('… — 2026-06-01T00:00:00Z — upcoming, hosting')).toBe(true);
  });

  it('says "no date", "(untitled)" and "no reply" where the event says nothing', () => {
    expect(briefLine({})).toBe('(untitled) — no date — no reply');
    expect(briefLine(null)).toBe('(untitled) — no date — no reply');
    expect(briefLine({ title: '  ', start: '', status: 'upcoming', rsvp: '' })).toBe('(untitled) — no date — upcoming, no reply');
  });

  it('escapes a title that starts with "-- " or "\\" with one leading backslash, so it never reads as a note', () => {
    expect(briefLine({ title: '-- none', start: '2026-06-01', status: 'upcoming', is_host: true })).toBe(
      '\\-- none — 2026-06-01 — upcoming, hosting',
    );
    expect(briefLine({ title: '\\back', start: '2026-06-01', status: 'upcoming', is_host: true })).toBe(
      '\\\\back — 2026-06-01 — upcoming, hosting',
    );
    expect(briefLine({ title: '--not a note', is_host: true })).toBe('--not a note — no date — hosting');
  });

  it('cuts the line as a WHOLE to 120 characters, title first, even when the tail alone overflows', () => {
    const line = briefLine({ title: 'Picnic in the park', start: '2026-06-01', status: 's'.repeat(200), is_host: true });
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.startsWith('Picnic')).toBe(true);
    expect(line).toContain(' — 2026-06-01 — ');
  });
});
