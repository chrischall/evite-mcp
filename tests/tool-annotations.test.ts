import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerEventTools } from '../src/tools/events.js';
import { registerGuestTools } from '../src/tools/guests.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerWriteTools } from '../src/tools/writes.js';

/**
 * The fleet annotation meta-test (modelled on skylight-mcp). It reads the
 * REGISTERED config rather than a hand-kept list, so a new tool that forgets
 * an annotation fails here instead of shipping with the spec defaults —
 * `destructiveHint` defaults to TRUE whenever `readOnlyHint` is false, so a
 * considered `false` and a forgotten one would otherwise look identical.
 */
interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

function registeredAnnotations(): Record<string, Ann | undefined> {
  const seen: Record<string, Ann | undefined> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Ann }) => {
      seen[name] = cfg.annotations;
    },
  } as never;
  const client = {} as never;
  for (const register of [
    registerHealthcheckTools,
    registerEventTools,
    registerGuestTools,
    registerMessageTools,
    registerWriteTools,
  ]) {
    register(server, client);
  }
  return seen;
}

describe('every tool declares its annotations', () => {
  it('registers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(registeredAnnotations())).toHaveLength(20);
  });

  it('sets an explicit boolean readOnlyHint on all of them', () => {
    const missing = Object.entries(registeredAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('sets an explicit boolean openWorldHint on every tool', () => {
    const missing = Object.entries(registeredAnnotations())
      .filter(([, a]) => typeof a?.openWorldHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('marks only the local healthcheck closed-world', () => {
    const closed = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.openWorldHint === false)
      .map(([name]) => name);
    expect(closed).toEqual(['evite_healthcheck']);
  });

  it('holds the additive writes to the ones with an inverse that reaches nobody', () => {
    // add_guest ⇄ remove_guest (draft guests are not emailed until evite_send);
    // create/duplicate ⇄ cancel_event (which also deletes a draft);
    // reinstate ⇄ cancel_event. Everything else reaches another person or has
    // no inverse here — upload_photo puts a photo in the album every guest
    // sees, and nothing in this tool set deletes a photo.
    const additive = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && a?.destructiveHint === false)
      .map(([name]) => name)
      .sort();
    expect(additive).toEqual([
      'evite_add_guest',
      'evite_create_event',
      'evite_duplicate_event',
      'evite_reinstate_event',
    ]);
  });

  it('lists exactly the served tools in manifest.json tools[]', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
      tools: Array<{ name: string }>;
    };
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(Object.keys(registeredAnnotations()).sort());
  });
});
