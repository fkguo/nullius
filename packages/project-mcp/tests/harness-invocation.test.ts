import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '@nullius/orchestrator';
import { writeHarnessInvocationMarker } from '@nullius/shared';
// Use the shipped adapter: its detached worker entrypoints exist in dist.
import { ProjectAdapter } from '../dist/adapter.js';
import { execute } from '../src/execute.js';
import { attempt, journal, requestPath, readDelivery, commitDelivery, type DeliveryRequest } from '../src/delivery.js';
import { acquireExecution } from '../src/execution-lock.js';
import { projectIdentity } from '../src/paths.js';
import type { Context } from '../src/policy.js';
import type { Result } from '../src/result.js';

const roots: string[] = [];
const run = promisify(execFile);
const supervisor = fileURLToPath(new URL('../dist/supervisor.js', import.meta.url));
const marker = (root: string) => path.join(root, '.nullius/HARNESS_INVOCATION');
const body = (result: Result): any => JSON.parse(result.content[0]!.text);
beforeEach(() => {
  vi.stubEnv('NULLIUS_HARNESS_VERIFY', 'on');
  vi.stubEnv('NULLIUS_CONTROL_DIR', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function bare() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-anchor-gate-')));
  roots.push(root);
  return root;
}
async function project() {
  const root = bare();
  expect(await runCli(['--project-root', root, 'init', '--mode', 'engine', '--no-git'], {
    cwd: root, stdout: () => {}, stderr: () => {},
  })).toBe(0);
  return { root, adapter: new ProjectAdapter(root) };
}
function stale(root: string) {
  writeHarnessInvocationMarker(root, { now: new Date('2000-01-01T00:00:00Z') });
}
/** Snapshot observable bytes/directories without following symlinks. */
function snapshot(root: string): unknown {
  const entries: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const relative = path.relative(root, target);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) entries[relative] = `link:${fs.readlinkSync(target)}`;
      else if (stat.isDirectory()) { entries[relative] = 'directory'; visit(target); }
      else entries[relative] = fs.readFileSync(target).toString('base64');
    }
  };
  visit(root);
  return entries;
}
function rejected(result: Result, code = 'HARNESS_INVOCATION_REQUIRED') {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  expect(body(result).error.code).toBe(code);
}
async function settle(adapter: ProjectAdapter, id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = body(await adapter.call('project_delivery_read', { delivery_id: id }));
    if (result.state === 'committed') return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Delivery ${id} did not commit`);
}
function prepared(root: string, id: string, dispatched = false): DeliveryRequest {
  const request: DeliveryRequest = { root, root_identity: projectIdentity(root), delivery_id: id,
    name: 'project_cli', args: { action: 'decision_record', text: 'fixture decision' }, timeout_seconds: 300 };
  const manager = journal(root);
  manager.observeToolIntents(id, [attempt(request)]);
  fs.writeFileSync(requestPath(root, id), JSON.stringify(request));
  if (dispatched) manager.markToolIntentsDispatched(id, [attempt(request)]);
  return request;
}

describe('project MCP enforces the live research-harness anchor', () => {
  it.each(['missing', 'stale', 'mismatched'] as const)('rejects %s bound-root reads/writes before any file, lock or journal effect', async condition => {
    const { root, adapter } = await project();
    expect(root).not.toBe(process.cwd());
    fs.writeFileSync(path.join(root, 'input.txt'), 'source');
    if (condition === 'missing') fs.rmSync(marker(root), { force: true });
    if (condition === 'stale') stale(root);
    if (condition === 'mismatched') {
      writeHarnessInvocationMarker(root);
      const value = JSON.parse(fs.readFileSync(marker(root), 'utf8'));
      value.project_root = bare();
      fs.writeFileSync(marker(root), JSON.stringify(value));
    }
    const before = snapshot(root);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['project_file_read', { path: 'input.txt' }],
      ['project_file_write', { path: 'inputs/rejected.txt', content: 'must not exist', expected_sha256: null }],
      ['project_cli', { action: 'current' }],
      ['project_cli', { action: 'decision_record', text: 'must not be recorded', delivery_id: 'blocked' }],
      ['orch_run_list', {}],
    ];
    for (const [name, args] of calls) {
      rejected(await adapter.call(name, args));
      expect(snapshot(root), name).toEqual(before);
    }
    const status = await adapter.call('project_cli', { action: 'status' });
    expect(status.isError, JSON.stringify(status)).not.toBe(true);
    expect(body(status).exit_code).toBe(0);
    const resumed = await adapter.call('project_file_write', { path: 'inputs/recovered.txt', content: 'recovered', expected_sha256: null });
    expect(resumed.isError, JSON.stringify(resumed)).not.toBe(true);
    expect(fs.readFileSync(path.join(root, 'inputs/recovered.txt'), 'utf8')).toBe('recovered');
  });

  it.each(['init', 'orch_run_create'] as const)('allows %s only for no-state bootstrap, not existing-state re-init', async operation => {
    const root = bare();
    const adapter = new ProjectAdapter(root);
    const name = operation === 'init' ? 'project_cli' : operation;
    const args = operation === 'init' ? { action: 'init', mode: 'engine' } : { run_id: 'bootstrap', workflow_id: 'computation' };
    expect((await adapter.call(name, { ...args, delivery_id: 'bootstrap' })).isError).not.toBe(true);
    const first = await settle(adapter, 'bootstrap');
    expect(first.result.isError, JSON.stringify(first)).not.toBe(true);
    expect(fs.existsSync(path.join(root, '.nullius/state.json'))).toBe(true);
    fs.rmSync(marker(root), { force: true });
    const before = snapshot(root);
    rejected(await adapter.call(name, { ...args, delivery_id: 'second' }));
    expect(snapshot(root)).toEqual(before);
    rejected(await adapter.call('project_cli', { action: 'init', runtime_only: true, delivery_id: 'runtime-again' }));
    expect(snapshot(root)).toEqual(before);
  }, 15_000);

  it('permits exact committed and unknown replay while stale, but not the first dispatch of not_started work', async () => {
    const { root, adapter } = await project();
    const committed = prepared(root, 'committed', true);
    const original: Result = { content: [{ type: 'text', text: '{"fixture":"original refusal"}' }], isError: true };
    commitDelivery(committed, original);
    prepared(root, 'unknown', true);
    prepared(root, 'not-started');
    stale(root);
    const before = snapshot(root);
    for (const id of ['committed', 'unknown']) {
      const recorded = readDelivery(root, id);
      const replay = await adapter.call('project_cli', { action: 'decision_record', text: 'fixture decision', delivery_id: id });
      expect(replay.isError).not.toBe(true);
      expect(body(replay)).toEqual(recorded);
      expect(body(await adapter.call('project_delivery_read', { delivery_id: id }))).toEqual(recorded);
    }
    expect((readDelivery(root, 'committed') as any).result).toEqual(original);
    rejected(await adapter.call('project_cli', { action: 'decision_record', text: 'fixture decision', delivery_id: 'not-started' }));
    expect(snapshot(root)).toEqual(before);
    expect(readDelivery(root, 'not-started').state).toBe('not_started');
  });

  it('rechecks direct execution and an already-dispatched worker, committing refusal and releasing its lock', async () => {
    const { root } = await project();
    const request = prepared(root, 'worker', true);
    acquireExecution(root, request.delivery_id);
    stale(root);
    const state = fs.readFileSync(path.join(root, '.nullius/state.json'));
    const ledger = fs.readFileSync(path.join(root, '.nullius/ledger.jsonl'));
    await expect(execute(root, request.name, request.args)).rejects.toMatchObject({ code: 'HARNESS_INVOCATION_REQUIRED' });
    await run(process.execPath, [supervisor, requestPath(root, request.delivery_id)], {
      cwd: os.tmpdir(), env: { ...process.env, NULLIUS_HARNESS_VERIFY: 'on' }, timeout: 10_000,
    });
    const delivered = readDelivery(root, request.delivery_id) as any;
    expect(delivered.state).toBe('committed');
    rejected(delivered.result);
    expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.nullius/state.json'))).toEqual(state);
    expect(fs.readFileSync(path.join(root, '.nullius/ledger.jsonl'))).toEqual(ledger);
  }, 15_000);

  it.each(['HARNESS_INVOCATION', 'state.json', 'ledger.jsonl'])('rejects a symlinked %s before reading it, including direct execution', async filename => {
    const { root, adapter } = await project();
    writeHarnessInvocationMarker(root);
    const outside = bare();
    const target = path.join(outside, 'private-control');
    fs.copyFileSync(path.join(root, '.nullius', filename), target);
    fs.unlinkSync(path.join(root, '.nullius', filename));
    fs.symlinkSync(target, path.join(root, '.nullius', filename));
    const before = snapshot(root);
    const external = snapshot(outside);
    rejected(await adapter.call('project_file_read', { path: 'research_plan.md' }), 'UNSAFE_FS');
    rejected(await adapter.call('project_cli', { action: 'status' }), 'UNSAFE_FS');
    await expect(execute(root, 'project_cli', { action: 'status' })).rejects.toMatchObject({ code: 'UNSAFE_FS' });
    expect(snapshot(root)).toEqual(before);
    expect(snapshot(outside)).toEqual(external);
  });

  it('checks sampling loopback after dispatch, exposes refusal, and lets explicit status recover it', async () => {
    const { root, adapter } = await project();
    await adapter.call('project_cli', { action: 'status' });
    const seen: string[] = [];
    let calls = 0;
    const createMessage: NonNullable<Context['createMessage']> = async params => {
      seen.push(JSON.stringify(params.messages));
      calls += 1;
      if (calls === 1) stale(root);
      if (calls <= 3) return { model: 'fixture', stopReason: 'tool_use', content: [{
        type: 'tool_use', id: `tool-${calls}`, name: calls === 2 ? 'orch_run_status' : 'orch_run_list', input: {},
      }] };
      return { model: 'fixture', stopReason: 'end_turn', content: { type: 'text', text: 'done' } };
    };
    const result = await adapter.call('orch_run_execute_agent', {
      _confirm: true, run_id: 'sampling-anchor', model: 'fixture', max_turns: 4,
      messages: [{ role: 'user', content: 'Exercise the local fixture tools.' }],
      tools: [{ name: 'orch_run_list', input_schema: {} }, { name: 'orch_run_status', input_schema: {} }],
    }, { createMessage });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(calls).toBe(4);
    expect(seen[1]).toContain('HARNESS_INVOCATION_REQUIRED');
    const resumedToolResult = JSON.parse(seen[3]!).at(-1);
    expect(JSON.stringify(resumedToolResult)).toContain('tool-3');
    expect(JSON.stringify(resumedToolResult)).not.toContain('HARNESS_INVOCATION_REQUIRED');
    // A fresh read after loopback status must also work through the public boundary.
    expect((await adapter.call('project_file_read', { path: 'research_plan.md' })).isError).not.toBe(true);
    expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(false);
  });
});
