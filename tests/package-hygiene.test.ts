// fleet-audit #440: a runtime dependency nothing imports is still installed by
// every `npx` user and still earns dependabot release bumps; a manifest entry
// that over-promises misleads the host's tool picker.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as T;

function sourceText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? sourceText(join(dir, e.name)) : e.name.endsWith('.ts') ? readFileSync(join(dir, e.name), 'utf8') : ''))
    .join('\n');
}

describe('package hygiene', () => {
  it('every runtime dependency is imported somewhere under src/', () => {
    const { dependencies = {} } = readJson<{ dependencies?: Record<string, string> }>('package.json');
    const src = sourceText(join(ROOT, 'src'));
    const unused = Object.keys(dependencies).filter((dep) => !new RegExp(`from '${dep}(/[^']*)?'`).test(src));
    expect(unused).toEqual([]);
  });

  it('the manifest describes evite_healthcheck as what it does (no network reachability check)', () => {
    const { tools } = readJson<{ tools: Array<{ name: string; description: string }> }>('manifest.json');
    const hc = tools.find((t) => t.name === 'evite_healthcheck');
    expect(hc?.description).not.toMatch(/reachab/i);
  });
});
