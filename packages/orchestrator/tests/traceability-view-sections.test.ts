import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTraceabilityView } from '../src/traceability-view.js';

/** The view exports EVERY notebook section with its staleness class — the
 *  per-section truth the fold-boundary registration gate consumes (the
 *  aggregates alone cannot say whether a DECLARED rewritten section carries
 *  a fresh stamp). */

let projectRoot: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'view-sections-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync('git', ['-C', projectRoot, ...args], { encoding: 'utf-8' });
}

describe('traceability view notebook.sections export', () => {
  it('lists every section with heading, class, and cause', () => {
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(projectRoot, 'a.txt'), '1');
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
    const head = git('rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(projectRoot, 'research_notebook.md'), [
      '# Notebook',
      '## Stamped section',
      `<!-- written-against: ${head} -->`,
      'text',
      '## Bare section',
      'text',
    ].join('\n'));

    const view = buildTraceabilityView(projectRoot);

    expect(view.notebook.sections).toHaveLength(2);
    const byHeading = Object.fromEntries(view.notebook.sections.map(section => [section.heading, section]));
    expect(byHeading['Stamped section']!.class).toBe('current');
    expect(byHeading['Bare section']!.class).toBe('unstamped');
    expect(typeof byHeading['Bare section']!.cause).toBe('string');
    // The aggregate counts must describe the same population the section
    // list enumerates — one truth, two projections.
    const listedCounts: Record<string, number> = {};
    for (const section of view.notebook.sections) {
      listedCounts[section.class] = (listedCounts[section.class] ?? 0) + 1;
    }
    for (const [cls, count] of Object.entries(view.notebook.counts)) {
      expect(listedCounts[cls] ?? 0).toBe(count);
    }
  });
});
