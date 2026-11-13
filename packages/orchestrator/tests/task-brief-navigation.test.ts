import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { readTaskBriefNavigation } from '../src/task-brief-navigation.js';

const roots: string[] = [];
const brief = 'artifacts/runs/unfinished/task brief.md';
const link = `[Task brief](${brief.replace(/ /g, '%20')})`;
const helper = fileURLToPath(new URL('../../../skills/research-harness/scripts/task_brief.py', import.meta.url));
const body = '# Current reasoning\n\nThe normalization remains unverified.\nNext: check the original definition.\n';

function project(plan = `## Current Status\n\n${link}\n`): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'brief-navigation-')));
  roots.push(root);
  fs.mkdirSync(path.dirname(path.join(root, brief)), { recursive: true });
  fs.writeFileSync(path.join(root, brief), body);
  fs.writeFileSync(path.join(root, 'original.md'), 'Original definitions\n');
  fs.writeFileSync(path.join(root, 'research_plan.md'), plan);
  return root;
}

async function cli(root: string, args: string[]) {
  let stdout = ''; let stderr = '';
  const code = await runCli(['--project-root', root, ...args], {
    cwd: root, stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
  });
  return { code, stdout, stderr };
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('task brief navigation and real restoration', () => {
  it('restores a file-mode task through status without accepting it or requiring an active engine run', async () => {
    const root = project(`## Current Status\n\n| Field | Current value |\n|---|---|\n| Evidence pointers | ${link} |\n`);
    expect((await cli(root, ['init', '--mode=file'])).code).toBe(0);
    execFileSync('python3', [helper, 'capture', '--project-root', root, '--brief', brief, '--source', 'original.md']);
    const status = await cli(root, ['status', '--json']);
    expect(status.code, status.stderr).toBe(0);
    const payload = JSON.parse(status.stdout);
    expect(payload.execution_mode).toBe('file');
    expect(payload.run_id).toBeFalsy();
    const navigation = payload.resume_context.task_brief;
    expect(navigation).toEqual(payload.recovery_context.task_brief);
    expect(navigation).toMatchObject({ status: 'available', path: brief, freshness: 'unchecked', scientific_acceptance: 'not_assessed' });
    const protectedFiles = ['.nullius/state.json', 'research_notebook.md', 'project_index.md'];
    const before = protectedFiles.map(file => fs.readFileSync(path.join(root, file)));
    const restored = spawnSync(navigation.restore_argv[0], navigation.restore_argv.slice(1), { encoding: 'utf8' });
    expect(restored.status, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({ status: 'fresh', body, scope: 'continuity_only', scientific_acceptance: 'not_assessed' });
    expect(protectedFiles.map(file => fs.readFileSync(path.join(root, file)))).toEqual(before);
    expect((await cli(root, ['notebook', 'check', '--json'])).code).not.toBe(0);
    const text = await cli(root, ['status']);
    expect(text.stdout).toContain('freshness unchecked; no scientific acceptance');
    expect(text.stdout.match(/task_brief_restore_argv:/g)).toHaveLength(1);
    fs.writeFileSync(path.join(root, 'original.md'), 'Changed definitions\n');
    const stale = spawnSync(navigation.restore_argv[0], navigation.restore_argv.slice(1), { encoding: 'utf8' });
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({ status: 'stale', body, changes: [{ path: 'original.md', reason: 'source_changed' }] });
  });

  it('never selects a historical, quoted, HTML or code example as the current task', () => {
    const root = project(`## Current Status\n\n\`\`\`md\n${link}\n\`\`\`\n\n<!-- ${link} -->\n\n<code>${link}</code>\n\n> ${link}\n\n### Milestone history\n\n${link}\n\n## Restart\n\n${link}\n`);
    expect(readTaskBriefNavigation(root)).toMatchObject({ status: 'unselected', candidates: [], restore_argv: null });
  });

  it.each(['template', 'code', 'pre', 'textarea'])('ignores cross-block %s containers before and inside Current Status', tag => {
    for (const plan of [
      `<${tag}>\n\n## Current Status\n\n${link}\n\n</${tag}>\n`,
      `## Current Status\n\n<${tag}>\n\n${link}\n\n</${tag}>\n`,
    ]) expect(readTaskBriefNavigation(project(plan))).toMatchObject({ status: 'unselected', candidates: [], restore_argv: null });
    const visible = `<${tag}>\n\n${link}\n\n</${tag}>\n\n## Current Status\n\n${link}\n`;
    expect(readTaskBriefNavigation(project(visible))).toMatchObject({ status: 'available', path: brief });
  });

  it.each([
    `## <template>Current Status</template>\n\n${link}\n`,
    `## Current Status\n\n[<template>Task brief</template>](${brief.replace(/ /g, '%20')})\n`,
    `> <template>\n\n## Current Status\n\n${link}\n\n</template>\n`,
  ])('does not infer visible selection from an HTML heading, label or quoted container', plan => {
    expect(readTaskBriefNavigation(project(plan))).toMatchObject({ status: 'unselected', candidates: [], restore_argv: null });
  });

  it('escapes terminal controls in displayed argv while preserving the exact file name', async () => {
    const root = project();
    expect((await cli(root, ['init', '--mode=file'])).code).toBe(0);
    const unusual = 'artifacts/runs/unfinished/line\u0085\u2028.md';
    fs.renameSync(path.join(root, brief), path.join(root, unusual));
    fs.writeFileSync(path.join(root, 'research_plan.md'), `## Current Status\n\n[Task brief](${encodeURI(unusual)})\n`);
    const text = (await cli(root, ['status'])).stdout;
    expect(text).not.toMatch(/[\u0085\u2028]/);
    const line = text.split('\n').find(value => value.startsWith('task_brief_restore_argv: '))!;
    expect(JSON.parse(line.slice('task_brief_restore_argv: '.length)).at(-1)).toBe(unusual);
  });

  it('does not search newer abandoned run files or read the metadata during status', () => {
    const root = project();
    fs.writeFileSync(path.join(root, brief), '<!-- nullius-task-brief\nmalformed but not read by navigation\n');
    const abandoned = path.join(root, 'artifacts/runs/later/task_brief.md');
    fs.mkdirSync(path.dirname(abandoned), { recursive: true });
    fs.writeFileSync(abandoned, 'This task was abandoned.');
    const navigation = readTaskBriefNavigation(root);
    expect(navigation).toMatchObject({ status: 'available', path: brief, freshness: 'unchecked' });
    const restored = spawnSync(navigation.restore_argv![0], navigation.restore_argv!.slice(1), { encoding: 'utf8' });
    expect(restored.status).toBe(2);
    expect(JSON.parse(restored.stdout)).toMatchObject({ status: 'invalid' });
  });

  it.each([
    `## Current Status\n\n${link}\n\n${link}\n`,
    `## Current Status\n\n${link}\n\n## Current Status\n\nNo selection\n`,
  ])('reports ambiguous explicit selections without choosing one', plan => {
    expect(readTaskBriefNavigation(project(plan))).toMatchObject({ status: 'ambiguous', restore_argv: null });
  });

  it.each([
    '../outside.md', 'artifacts/runs/a/../../outside.md',
    'artifacts/runs/a/%2e%2e/outside.md', 'artifacts/runs/a/%2Fabsolute.md',
    'artifacts/runs/a/task.md?query=yes', 'https://example.org/task.md',
    'artifacts/runs/a/%00task.md', 'artifacts/runs/a/%5Ctask.md',
  ])('refuses unsafe task brief destination %s', target => {
    expect(readTaskBriefNavigation(project(`## Current Status\n\n[Task brief](${target})\n`)))
      .toMatchObject({ status: 'unavailable', restore_argv: null });
  });

  it.each(['brief', 'ancestor', 'plan'])('refuses %s symlinks without following them', kind => {
    const root = project();
    const target = kind === 'plan' ? path.join(root, 'research_plan.md')
      : kind === 'ancestor' ? path.dirname(path.join(root, brief)) : path.join(root, brief);
    const moved = `${target}.saved`;
    fs.renameSync(target, moved);
    fs.symlinkSync(moved, target, kind === 'ancestor' ? 'dir' : 'file');
    expect(readTaskBriefNavigation(root)).toMatchObject({ status: 'unavailable', restore_argv: null });
  });

  it('reports a dangling plan symlink as unavailable instead of an absent selection', () => {
    const root = project();
    const plan = path.join(root, 'research_plan.md');
    fs.unlinkSync(plan);
    fs.symlinkSync('missing-plan.md', plan);
    expect(readTaskBriefNavigation(root)).toMatchObject({ status: 'unavailable', restore_argv: null });
  });

  it('keeps ordinary status and pending decisions readable when a selected brief is missing', async () => {
    const root = project();
    expect((await cli(root, ['init', '--mode=file'])).code).toBe(0);
    expect((await cli(root, ['decision', 'pending', 'Resolve the scientific scope'])).code).toBe(0);
    fs.unlinkSync(path.join(root, brief));
    const status = await cli(root, ['status', '--json']);
    expect(status.code, status.stderr).toBe(0);
    const payload = JSON.parse(status.stdout);
    expect(payload.resume_context.task_brief).toMatchObject({ status: 'unavailable', path: brief, restore_argv: null });
    expect(JSON.stringify(payload.decision_ledger)).toContain('Resolve the scientific scope');
  });
});
