import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ANTI_DRIFT_SCRIPT_PATTERN = /^check-[a-z0-9-]+-anti-drift\.mjs$/;
const WIRED_SCRIPT_PATTERN = /\bnode\s+scripts\/(check-[a-z0-9-]+-anti-drift\.mjs)\b/g;

function repoRootFromThisFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

function discoverAntiDriftScripts(repoRoot: string): string[] {
  return fs
    .readdirSync(path.join(repoRoot, 'scripts'), { withFileTypes: true })
    .filter(entry => entry.isFile() && ANTI_DRIFT_SCRIPT_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function antiDriftWiringErrors(scripts: string[], workflow: string): string[] {
  const errors: string[] = [];
  const discovered = new Set(scripts);

  for (const script of scripts) {
    const command = `node scripts/${script}`;
    const count = countOccurrences(workflow, command);
    if (count === 0) {
      errors.push(`missing CI wiring: ${command}`);
    } else if (count > 1) {
      errors.push(`duplicate CI wiring (${count}): ${command}`);
    }
  }

  for (const match of workflow.matchAll(WIRED_SCRIPT_PATTERN)) {
    const script = match[1]!;
    if (!discovered.has(script)) {
      errors.push(`CI references missing anti-drift script: ${script}`);
    }
  }

  return [...new Set(errors)].sort((left, right) => left.localeCompare(right));
}

describe('CI anti-drift wiring', () => {
  const repoRoot = repoRootFromThisFile();
  const scripts = discoverAntiDriftScripts(repoRoot);
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf-8');

  it('wires every repository anti-drift lock into CI exactly once', () => {
    expect(scripts.length).toBeGreaterThan(0);
    expect(antiDriftWiringErrors(scripts, workflow)).toEqual([]);
  });

  it('rejects removal of every discovered anti-drift lock from CI', () => {
    for (const script of scripts) {
      const command = `node scripts/${script}`;
      const withoutCommand = workflow.replace(command, '');

      expect(withoutCommand, `${command} must be present before exercising its negative control`).not.toBe(
        workflow,
      );
      expect(antiDriftWiringErrors(scripts, withoutCommand)).toContain(
        `missing CI wiring: ${command}`,
      );
    }
  });

  it('rejects duplicate anti-drift lock wiring', () => {
    const command = `node scripts/${scripts[0]!}`;
    const duplicated = `${workflow}\n      - run: ${command}\n`;

    expect(antiDriftWiringErrors(scripts, duplicated)).toContain(
      `duplicate CI wiring (2): ${command}`,
    );
  });
});
