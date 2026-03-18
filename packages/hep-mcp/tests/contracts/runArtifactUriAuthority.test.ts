import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..');
}

function collectSourceFiles(dirPath: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) {
      out.push(fullPath);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function findInlineRunUriDrift(source: string): string[] {
  const offenders: string[] = [];
  const checks = [
    { label: 'template', re: /hep:\/\/runs\/\$\{/ },
    { label: 'concat', re: /['"`]hep:\/\/runs\/['"`]\s*\+/ },
    { label: 'local_helper', re: /\bfunction\s+runArtifactUri\s*\(/ },
    { label: 'local_parse_helper', re: /\bfunction\s+parseRun[A-Za-z0-9_]*Uri\s*\(/ },
    { label: 'inline_parse_regex', re: /\.match\(\s*\/\^hep:\/\/runs\// },
  ];

  for (const [index, line] of source.split('\n').entries()) {
    for (const check of checks) {
      if (check.re.test(line)) {
        offenders.push(`L${index + 1}:${check.label}`);
      }
    }
  }

  return offenders;
}

describe('hep run URI authority anti-drift gate', () => {
  it('keeps inline hep://runs construction out of hep-mcp source files', () => {
    const repoRoot = repoRootFromThisFile();
    const srcRoot = path.join(repoRoot, 'packages', 'hep-mcp', 'src');
    const authorityFile = path.join(srcRoot, 'core', 'runArtifactUri.ts');
    const offenders = collectSourceFiles(srcRoot)
      .filter(filePath => filePath !== authorityFile)
      .flatMap(filePath => {
        const matches = findInlineRunUriDrift(fs.readFileSync(filePath, 'utf-8'));
        const relPath = path.relative(repoRoot, filePath);
        return matches.map(match => `${relPath}:${match}`);
      });

    expect(offenders).toEqual([]);
  });
});
