import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '@chrischall/mcp-utils';
import type { EviteClient } from '../client.js';

export function registerHealthcheckTools(server: McpServer, client: EviteClient): void {
  server.registerTool(
    'evite_healthcheck',
    { description: 'Report evite-mcp status and the resolved auth mode.', annotations: { readOnlyHint: true } },
    async () => textResult(client.health()),
  );
}
