import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { toolAnnotations } from '@chrischall/mcp-utils';
import { briefResponse, listEventsViewArg, viewArg, viewResponse } from '../view.js';
import type { EviteClient, EventStatus } from '../client.js';
import { familyMeta } from './hints.js';

const EVENT_STATUS = ['upcoming', 'draft', 'archived', 'past', 'canceled'] as const;

const listEventsArgs = z.object({
  filterBy: z
    .enum(['all', 'host', 'others'])
    .default('all')
    .describe('Whose events to list: all, host (you are hosting), or others (you are a guest).'),
  status: z
    .array(z.enum(EVENT_STATUS))
    .optional()
    .describe(
      'Repeatable status filter (upcoming, draft, archived, past, canceled). ' +
        'Default: upcoming + past; with view "brief", upcoming only.',
    ),
  offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
  numResults: z.number().int().positive().optional().describe('Page size.'),
  filter: z.string().optional().describe('Free-text search over event titles.'),
});

const eventIdArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
});

const listTemplatesArgs = z.object({
  category: z
    .string()
    .min(1)
    .describe(
      'Gallery category path, e.g. "birthday/kids-teens/kids-birthday", "party", or "wedding".',
    ),
  free_only: z.boolean().default(false).describe('List only free (non-premium) templates.'),
});

const BRIEF_MAX = 120;
/** The page a brief read asks for when the caller names none, so "-- more" can be said truthfully. */
export const BRIEF_PAGE = 25;
const BRIEF_WHO_WROTE = "Event titles are written by each event's host.";

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * One event as one line, `title — <ISO start | no date> — <status>`, at most
 * 120 characters (the title is shortened). Read only from fields the list
 * endpoint carries (`title`, `start`, `status`, `is_host`, `rsvp` — see
 * tests/fixtures/events-list.json). The status is Evite's own event status
 * plus your part in it: `hosting`, `rsvp <yes|no|maybe>`, or `no reply`.
 */
export function briefLine(event: unknown): string {
  const ev = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
  const title = str(ev.title) ?? '(untitled)';
  const start = str(ev.start) ?? 'no date';
  const rsvp = str(ev.rsvp);
  const role = ev.is_host === true ? 'hosting' : rsvp ? `rsvp ${rsvp}` : 'no reply';
  const status = str(ev.status);
  const tail = ` — ${start} — ${status ? `${status}, ${role}` : role}`;
  const room = BRIEF_MAX - tail.length;
  const shown = title.length > room ? `${title.slice(0, Math.max(room - 1, 0))}…` : title;
  return `${shown}${tail}`;
}

export function registerEventTools(server: McpServer, client: EviteClient): void {
  server.registerTool(
    'evite_list_events',
    {
      description:
        'List your Evite events (GET /services/events/v1/). Returns events plus a totals breakdown. ' +
        'filterBy=others returns events where you are a guest. view "brief" answers one line per ' +
        `event (title — start — status), upcoming events only unless status is given, ${BRIEF_PAGE} per page ` +
        'unless numResults is given.',
      annotations: toolAnnotations({ title: 'List Evite events', openWorld: true }),
      _meta: familyMeta('whats-on', {
        canonical: true,
        aliases: ['party', 'parties', 'invitations', 'invites', 'evite', 'rsvps', 'birthday party'],
      }),
      inputSchema: z.object({ ...listEventsArgs.shape, view: listEventsViewArg() }),
    },
    async (args) => {
      const brief = args.view === 'brief';
      const numResults = args.numResults ?? (brief ? BRIEF_PAGE : undefined);
      const data = await client.listEvents({
        filterBy: args.filterBy,
        status: (args.status ?? (brief ? ['upcoming'] : ['upcoming', 'past'])) as EventStatus[],
        offset: args.offset,
        numResults,
        filter: args.filter,
      });
      if (!brief) return viewResponse(args.view, data);
      const events = Array.isArray(data?.events) ? data.events : [];
      const lines = events.map(briefLine);
      if (lines.length === 0) lines.push('-- none');
      // Evite's totals overlap across statuses, so no honest M exists for
      // "-- N of M shown"; a full page is the signal that more may follow.
      else if (numResults !== undefined && events.length >= numResults) lines.push('-- more');
      return briefResponse(lines, BRIEF_WHO_WROTE);
    },
  );

  server.registerTool(
    'evite_get_event',
    {
      description:
        'Get a single Evite event detail (GET /services/event/v1/{id}): event, settings, location, and more.',
      annotations: toolAnnotations({ title: 'Get Evite event detail', openWorld: true }),
      _meta: familyMeta('lookup', { aliases: ['party details', 'event details', 'where is the party'] }),
      inputSchema: z.object({ ...eventIdArgs.shape, view: viewArg() }),
    },
    async (args) => {
      const data = await client.getEvent(args.event_id);
      return viewResponse(args.view, data);
    },
  );

  server.registerTool(
    'evite_list_templates',
    {
      description:
        'List invitation templates from a gallery category — use this to find the `template_name` ' +
        'that evite_create_event requires. `category` is a gallery path, e.g. ' +
        '"birthday/kids-teens/kids-birthday", "party", "wedding", or "baby-kids/baby/baby-shower". ' +
        'Set free_only:true to list only free templates. Returns each template’s slug (= ' +
        'template_name) and a readable display name.',
      annotations: toolAnnotations({ title: 'List Evite invitation templates', openWorld: true }),
      _meta: familyMeta('lookup', { aliases: ['invitation designs', 'invite templates'] }),
      inputSchema: z.object({ ...listTemplatesArgs.shape, view: viewArg() }),
    },
    async (args) => {
      const data = await client.listTemplates(args.category, args.free_only);
      return viewResponse(args.view, data);
    },
  );
}
