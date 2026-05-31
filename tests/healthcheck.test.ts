import { describe, it, expect } from 'vitest';
import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { EviteClient } from '../src/client.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';

describe('evite_healthcheck', () => {
  it('reports ok with the scaffold auth mode', async () => {
    const client = new EviteClient();
    const h = await createTestHarness((server) => registerHealthcheckTools(server, client));
    const res = await h.callTool('evite_healthcheck', {});
    const data = parseToolResult<{ ok: boolean; authMode: string }>(res);
    expect(data.ok).toBe(true);
    expect(data.authMode).toBe('none');
    await h.close();
  });
});
