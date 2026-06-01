import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { EviteClient, EventStatus } from '../client.js';

const EVENT_STATUS = ['upcoming', 'draft', 'archived', 'past', 'canceled'] as const;

const listEventsArgs = z.object({
  filterBy: z
    .enum(['all', 'host', 'others'])
    .default('all')
    .describe('Whose events to list: all, host (you are hosting), or others (you are a guest).'),
  status: z
    .array(z.enum(EVENT_STATUS))
    .default(['upcoming', 'past'])
    .describe('Repeatable status filter (upcoming, draft, archived, past, canceled).'),
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

export function registerEventTools(server: McpServer, client: EviteClient): void {
  server.registerTool(
    'evite_list_events',
    {
      description:
        'List your Evite events (GET /services/events/v1/). Returns events plus a totals breakdown. ' +
        'filterBy=others returns events where you are a guest.',
      annotations: toolAnnotations({ title: 'List Evite events' }),
      inputSchema: listEventsArgs.shape,
    },
    async (raw) => {
      const args = listEventsArgs.parse(raw);
      const data = await client.listEvents({
        filterBy: args.filterBy,
        status: args.status as EventStatus[],
        offset: args.offset,
        numResults: args.numResults,
        filter: args.filter,
      });
      return textResult(data);
    },
  );

  server.registerTool(
    'evite_get_event',
    {
      description:
        'Get a single Evite event detail (GET /services/event/v1/{id}): event, settings, location, and more.',
      annotations: toolAnnotations({ title: 'Get Evite event detail' }),
      inputSchema: eventIdArgs.shape,
    },
    async (raw) => {
      const args = eventIdArgs.parse(raw);
      const data = await client.getEvent(args.event_id);
      return textResult(data);
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
      annotations: toolAnnotations({ title: 'List Evite invitation templates' }),
      inputSchema: listTemplatesArgs.shape,
    },
    async (raw) => {
      const args = listTemplatesArgs.parse(raw);
      const data = await client.listTemplates(args.category, args.free_only);
      return textResult(data);
    },
  );
}
