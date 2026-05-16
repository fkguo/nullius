import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..');
}

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(repoRootFromThisFile(), relPath), 'utf-8');
}

describe('MCP server capability contract', () => {
  it.each([
    'packages/hep-mcp/src/index.ts',
    'packages/pdg-mcp/src/index.ts',
  ])('%s does not advertise or register MCP resources', relPath => {
    const source = readRepoFile(relPath);

    expect(source).not.toContain('resources: {}');
    expect(source).not.toContain('ListResourcesRequestSchema');
    expect(source).not.toContain('ListResourceTemplatesRequestSchema');
    expect(source).not.toContain('ReadResourceRequestSchema');
  });

  it('tool results do not emit MCP resource_link content blocks', () => {
    const source = readRepoFile('packages/hep-mcp/src/tools/dispatcher.ts');

    expect(source).not.toContain('resource_link');
    expect(source).not.toContain('appendResourceLinks');
  });
});
