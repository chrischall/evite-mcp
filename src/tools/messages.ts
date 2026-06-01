import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { EviteClient } from '../client.js';

const eventIdArgs = z.object({
  event_id: z.string().min(1).describe('Evite event id (event_id from evite_list_events).'),
});

export function registerMessageTools(server: McpServer, client: EviteClient): void {
  server.registerTool(
    'evite_list_messages',
    {
      description:
        "List the messages on an Evite event's Messages tab (GET /services/event/v1/{id}/posts/).",
      annotations: toolAnnotations({ title: 'List Evite event messages' }),
      inputSchema: eventIdArgs.shape,
    },
    async (raw) => {
      const args = eventIdArgs.parse(raw);
      const data = await client.listMessages(args.event_id);
      return textResult(data);
    },
  );
}
