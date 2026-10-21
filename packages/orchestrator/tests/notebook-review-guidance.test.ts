import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli-args.js';
import { runCli } from '../src/cli.js';
import { renderHelp } from '../src/cli-help.js';
import { notebookBudgets } from '../src/notebook-review-batches.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const template = 'packages/project-contracts/src/project_contracts/scaffold_templates/AGENTS.md';
const read = (relative: string) => fs.readFileSync(path.join(repository, relative), 'utf8');
const defaults = notebookBudgets({});
const parsed = parseCliArgs(['notebook', 'review', '--model', 'claude/fixture']);
if (parsed.command !== 'notebook') throw new Error('notebook argument parser unavailable');

// Compare published instructions with executable defaults, not another copy of
// those numbers. Behavioral coverage remains in notebook-review-batches.test.ts.
function guidanceIssues(text: string): string[] {
  const prose = text.replace(/`/g, '').replace(/\s+/g, ' ');
  const issues: string[] = [];
  const budgets: Array<[string, RegExp, number]> = [
    ['snapshot bytes', /--snapshot-bytes, default ([\d,]+) MiB/, defaults.snapshotBytes / (1024 * 1024)],
    ['file count', /--max-files, default ([\d,]+)/, defaults.maxFiles],
    ['context tokens', /--context-tokens window \(default ([\d,]+) tokens/, defaults.contextTokens],
    ['timeout', /execution budget is ([\d,]+) seconds/, parsed.timeoutSecs!],
    ['call count', /execution budget is [\d,]+ seconds and ([\d,]+) calls/, defaults.maxBatches],
  ];
  for (const [name, pattern, value] of budgets) {
    const match = pattern.exec(prose);
    if (!match || Number(match[1].replace(/,/g, '')) !== value) issues.push(name);
  }
  const required = [
    'Valid UTF-8 text remains text regardless of size',
    'Binary or invalid UTF-8 linked files',
    'is separate from each request',
    'joint audit receiving the COMPLETE original notebook and text dependencies',
    'All intervals and the joint audit must be complete and fresh',
    'one attempt per call and no automatic retry',
    '--resume <run-id> creates a new run',
    'Only tool mode none is accepted',
    'do not establish independent confirmations or a cross-family quorum',
  ];
  for (const statement of required) if (!prose.includes(statement)) issues.push(statement);
  if (/binary or oversized|text packet closure is limited to|total snapshot storage to/i.test(prose)) {
    issues.push('retired size-based text restriction');
  }
  if (/review executes (?:a real reviewer )?once/i.test(prose)) issues.push('single-call review restriction');
  return issues;
}

const temporaryRoots: string[] = [];
function project(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-guidance-')));
  temporaryRoots.push(root);
  return root;
}
async function cli(root: string, args: string[]): Promise<void> {
  let output = '';
  const code = await runCli(['--project-root', root, ...args], {
    stdout: text => { output += text; }, stderr: text => { output += text; },
  });
  expect(code, output).toBe(0);
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('notebook review instruction drift', () => {
  it.each([
    template, 'README.md', 'docs/QUICKSTART.md', 'docs/TESTING_GUIDE.md',
    'docs/ARCHITECTURE.md', 'docs/PROJECT_STATUS.md', 'packages/orchestrator/README.md',
    'skills/research-harness/references/notebook-review-budget.md',
    'skills/research-team/RUNBOOK.md', 'skills/research-team/assets/prompts_readme_template.md',
    'skills/research-team/assets/team_packet_template.txt',
  ])('keeps %s aligned with runtime budgets and complete-original review', relative => {
    expect(guidanceIssues(read(relative)), relative).toEqual([]);
  });

  it('keeps CLI help aligned with runtime defaults', () => {
    const help = renderHelp('notebook');
    expect(help).toContain(`Storage defaults: ${defaults.snapshotBytes / (1024 * 1024)} MiB and ${defaults.maxFiles} files`);
    expect(help).toContain(`window (default ${defaults.contextTokens})`);
    expect(help).toContain(`Default hard budget: ${parsed.timeoutSecs} seconds, max ${defaults.maxBatches} calls`);
  });

  it('keeps the generated notebook instructions aligned with bounded semantic review', () => {
    const prose = read('packages/project-contracts/src/project_contracts/scaffold_templates/research_notebook.md').replace(/\s+/g, ' ');
    expect(prose).toContain('bounded calls');
    expect(prose).toContain('one attempt per call and no automatic retry');
    expect(prose).toContain(`default hard ${parsed.timeoutSecs}-second timeout`);
    expect(prose).not.toMatch(/review executes (?:a real reviewer )?once/i);
  });

  it('renders current review guidance in the executable adjudication builder', () => {
    const root = project();
    const report = path.join(root, 'member.md');
    const output = path.join(root, 'adjudication.md');
    fs.writeFileSync(report, '# Anonymous software fixture\n\n## Major Gaps\n- (none)\n');
    execFileSync('python3', [
      path.join(repository, 'skills/research-team/scripts/bin/build_adjudication_response.py'),
      '--tag', 'guidance-fixture', '--member-a', report, '--member-b', report, '--out', output,
    ]);
    expect(guidanceIssues(fs.readFileSync(output, 'utf8'))).toEqual([]);
  });

  it.each([
    ['retired storage cap', (text: string) => text.replace('default 512 MiB', 'default 64 MiB')],
    ['retired text classification', (text: string) => text.replace('Binary or invalid UTF-8 linked files', 'Automatically linked binary or oversized files')],
    ['retired text cap', (text: string) => text + '\nThe text packet closure is limited to 1 MiB.\n'],
    ['changed context default', (text: string) => text.replace('200,000 tokens', '100,000 tokens')],
    ['missing joint review', (text: string) => text.replace('joint audit receiving the COMPLETE original notebook and text\ndependencies', 'joint audit receiving selected summaries')],
    ['single-call review', (text: string) => text.replace('one semantic review through the existing review-swarm launcher in bounded calls', 'a real reviewer once through the existing review-swarm launcher')],
  ] as const)('rejects a controlled %s regression', (_label, mutate) => {
    const original = read(template);
    expect(guidanceIssues(original)).toEqual([]);
    const changed = mutate(original);
    expect(changed).not.toBe(original);
    expect(guidanceIssues(changed).length).toBeGreaterThan(0);
  });

  it('generates current notebook guidance through the public init command', async () => {
    const root = project();
    await cli(root, ['init']);
    expect(guidanceIssues(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'))).toEqual([]);
  });

  it('preserves old customized instructions and mode through every non-destructive init path', async () => {
    const root = project();
    await cli(root, ['init']);
    const agents = path.join(root, 'AGENTS.md');
    const claude = path.join(root, 'CLAUDE.md');
    const custom = Buffer.from('# Owner instructions\r\n\r\n研究约定：保留。\r\nText packet closure is limited to 1 MiB.\r\n');
    const host = Buffer.from('@AGENTS.md\r\n\r\nOwner-specific host guidance.\r\n');
    fs.writeFileSync(agents, custom); fs.chmodSync(agents, 0o640);
    fs.writeFileSync(claude, host); fs.chmodSync(claude, 0o600);
    for (const args of [['init'], ['init', '--refresh', '--dry-run'], ['init', '--refresh'], ['init', '--runtime-only']]) {
      await cli(root, args);
      expect(fs.readFileSync(agents), args.join(' ')).toEqual(custom);
      expect(fs.statSync(agents).mode & 0o777).toBe(0o640);
      expect(fs.readFileSync(claude), args.join(' ')).toEqual(host);
      expect(fs.statSync(claude).mode & 0o777).toBe(0o600);
    }
    const preview = project();
    await cli(preview, ['init']);
    expect(guidanceIssues(fs.readFileSync(path.join(preview, 'AGENTS.md'), 'utf8'))).toEqual([]);
    expect(fs.readFileSync(agents)).toEqual(custom);
  });
});
