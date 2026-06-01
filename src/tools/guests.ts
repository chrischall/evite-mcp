import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { EviteClient } from '../client.js';

const eventIdArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
});

export function registerGuestTools(server: McpServer, client: EviteClient): void {
  server.registerTool(
    'evite_list_guests',
    {
      description:
        'List the guests for an Evite event (GET /services/event/v1/{id}/guests/): name, RSVP response, ' +
        'head counts, delivery status, and more.',
      annotations: toolAnnotations({ title: 'List Evite event guests' }),
      inputSchema: eventIdArgs.shape,
    },
    async (raw) => {
      const args = eventIdArgs.parse(raw);
      const data = await client.listGuests(args.event_id);
      return textResult(data);
    },
  );

  server.registerTool(
    'evite_rsvp_summary',
    {
      description:
        'Get the RSVP summary for an Evite event (yes/no/maybe/noReply plus adult/kid head counts). ' +
        'Derived from the event guests endpoint.',
      annotations: toolAnnotations({ title: 'Evite RSVP summary' }),
      inputSchema: eventIdArgs.shape,
    },
    async (raw) => {
      const args = eventIdArgs.parse(raw);
      const data = await client.rsvpSummary(args.event_id);
      return textResult(data);
    },
  );
}
