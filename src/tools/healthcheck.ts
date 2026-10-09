import type { McpServer } from '@modelcontextprotocol/server';
import { minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { EviteClient } from '../client.js';

export function registerHealthcheckTools(server: McpServer, client: EviteClient): void {
  server.registerTool(
    'evite_healthcheck',
    { description: 'Report evite-mcp status and the resolved auth mode.', annotations: toolAnnotations({ title: 'Evite healthcheck', openWorld: false }) },
    async () => minifiedResult(client.health()),
  );
}
