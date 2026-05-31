#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { EviteClient } from './client.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';

const client = new EviteClient();

await runMcp({
  name: 'evite-mcp',
  version: '0.1.0', // x-release-please-version
  banner: '[evite-mcp] This project was developed and is maintained by AI. Use at your own discretion.',
  deps: client,
  tools: [registerHealthcheckTools],
});
