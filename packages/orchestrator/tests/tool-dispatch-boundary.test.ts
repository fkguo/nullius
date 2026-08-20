import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(resolved);
    return entry.isFile() && entry.name.endsWith('.ts') ? [resolved] : [];
  });
}

function matchingFiles(pattern: RegExp): string[] {
  return sourceFiles(SRC_DIR).flatMap(filePath => {
    const source = fs.readFileSync(filePath, 'utf8');
    const count = [...source.matchAll(pattern)].length;
    const relative = path.relative(SRC_DIR, filePath).split(path.sep).join('/');
    return Array.from({ length: count }, () => relative);
  }).sort();
}

describe('tool dispatch boundary anti-drift', () => {
  it('keeps raw transport calls confined to the central gateway and explicit adapters', () => {
    expect(matchingFiles(/\.callTool\s*\(/g)).toEqual([
      'agent-runner-ops.ts',
      'team-execution-tool-bridge.ts',
      'workflow-runtime.ts',
    ]);
  });

  it('keeps production AgentRunner construction on the delegated runtime gateway', () => {
    expect(matchingFiles(/new\s+AgentRunner\s*\(/g)).toEqual([
      'research-loop/delegated-agent-runtime.ts',
    ]);
  });
});
