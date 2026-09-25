import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '@nullius/orchestrator';
import { ProjectAdapter } from '../src/adapter.js';
import { attempt, journal, requestPath, readRequest, readDelivery, commitDelivery, type DeliveryRequest } from '../src/delivery.js';
import { projectIdentity } from '../src/paths.js';
import { acquireExecution, releaseExecution } from '../src/execution-lock.js';
import { execute } from '../src/execute.js';

const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-project-boundary-')));
  roots.push(root);
  return { root, adapter: new ProjectAdapter(root) };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const body = (result: Awaited<ReturnType<ProjectAdapter['call']>>) => JSON.parse(result.content[0]!.text);

describe('single-project transport boundaries', () => {
  it('requires create-only or matching hashes and returns bounded source bytes', async () => {
    const { adapter } = fixture();
    const args = { path: 'inputs/example.txt', content: 'αβ example', expected_sha256: null };
    const first = body(await adapter.call('project_file_write', args));
    expect(first.sha256).toBe(createHash('sha256').update(args.content).digest('hex'));
    expect((await adapter.call('project_file_write', args)).isError).toBe(true);
    expect((await adapter.call('project_file_write', { ...args, expected_sha256: '0'.repeat(64) })).isError).toBe(true);
    expect((await adapter.call('project_file_write', { ...args, content: 'changed', expected_sha256: first.sha256 })).isError).not.toBe(true);
    const chunk = body(await adapter.call('project_file_read', { path: args.path, max_bytes: 3 }));
    expect(Buffer.from(chunk.data, 'base64').toString()).toBe('cha');
    expect(chunk.next_offset).toBe(3);
  });
  it('denies traversal, symlinks, case aliases and forged runtime receipts', async () => {
    const { root, adapter } = fixture();
    const outside = fixture().root;
    fs.symlinkSync(outside, path.join(root, 'link'));
    fs.symlinkSync(path.join(outside, 'missing'), path.join(root, 'dangling'));
    for (const file of ['../escape', `${outside}/escape`, 'link/escape', 'dangling/escape', '.nullius/state.json', 'agents.md', 'PROJECT_INDEX.md', 'RESEARCH_TEAM_CONFIG.JSON', 'ARTIFACTS/delegated-runs/project-mcp/request/manifest.json', 'Artifacts/runs/run/artifacts/computation_result_v1.json', 'artifacts/runs/run/verification/validation_chain_receipt_v1.json']) {
      expect((await adapter.call('project_file_write', { path: file, content: '{}', expected_sha256: null })).isError, file).toBe(true);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it('reports transient lock ownership and malformed workflow URIs without granting recovery authority', async () => {
    const { root, adapter } = fixture();
    acquireExecution(root, 'sampling-fixture');
    const busy = body(await adapter.call('project_file_write', { path: 'input.md', content: 'draft', expected_sha256: null }));
    expect(JSON.stringify(busy)).toContain('sampling-fixture');
    expect(JSON.stringify(busy)).toContain(String(process.pid));
    expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(true);
    releaseExecution(root, 'sampling-fixture');
    fs.writeFileSync(path.join(root, '.nullius/state.json'), JSON.stringify({ run_id: 'run', artifacts: { x: 'orch://runs/run/artifact/%ZZ' } }));
    const malformed = body(await adapter.call('project_cli', { action: 'status' }));
    expect(JSON.stringify(malformed)).toContain('INVALID_PARAMS');
    expect(JSON.stringify(malformed)).toContain('Malformed workflow artifact URI');
  });
  it('guards implicit control files for both orch and CLI calls', async () => {
    const { root, adapter } = fixture();
    const outside = fixture().root;
    const target = path.join(outside, 'ledger.jsonl');
    fs.writeFileSync(target, 'unchanged');
    fs.mkdirSync(path.join(root, '.nullius'));
    fs.symlinkSync(target, path.join(root, '.nullius/ledger.jsonl'));
    expect((await adapter.call('orch_run_create', { run_id: 'run', delivery_id: 'create' })).isError).toBe(true);
    expect((await adapter.call('project_cli', { action: 'status' })).isError).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
  });
  it('allows status with unreferenced data and virtual-environment symlinks', async () => {
    const { root, adapter } = fixture();
    expect(await runCli(['--project-root', root, 'init'], { cwd: root, stdout: () => {}, stderr: () => {} })).toBe(0);
    const outside = fixture().root;
    fs.mkdirSync(path.join(root, 'artifacts/runs/old/computation/.venv/bin'), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(root, 'artifacts/runs/old/computation/.venv/bin/node'));
    fs.symlinkSync(outside, path.join(root, 'artifacts/provider-cache'));
    fs.symlinkSync(outside, path.join(root, 'artifacts/runs/old/computation/inputs'));
    const response = await adapter.call('project_cli', { action: 'status' });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(body(response).exit_code).toBe(0);
  });
  it('checks actual workflow references and nested runner logs outside fixed metadata trees', async () => {
    const { root, adapter } = fixture();
    const outside = fixture().root;
    fs.mkdirSync(path.join(root, '.nullius'));
    fs.mkdirSync(path.join(root, 'inputs'));
    fs.symlinkSync(outside, path.join(root, 'inputs/external'));
    fs.writeFileSync(path.join(root, '.nullius/state.json'), JSON.stringify({ run_id: 'run', artifacts: { calculation: 'inputs/external/result.json' } }));
    const expectSymlinkRejection = async () => {
      const result = await adapter.call('project_cli', { action: 'status' });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('Symlinks');
    };
    await expectSymlinkRejection();
    fs.writeFileSync(path.join(root, '.nullius/state.json'), JSON.stringify({ run_id: 'run' }));
    fs.mkdirSync(path.join(root, 'artifacts/runs/run/data'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'artifacts/runs/run/data/external'));
    fs.writeFileSync(path.join(root, '.nullius/ledger.jsonl'), JSON.stringify({ run_id: 'run', event_type: 'workflow_step_completed', step_id: 'calculate', details: { artifact_uri: 'orch://runs/run/artifact/data/external/result.json' } }) + '\n');
    await expectSymlinkRejection();
    fs.writeFileSync(path.join(root, '.nullius/state.json'), JSON.stringify({ run_id: 'run', plan: { steps: [{ step_id: 'calculate', execution: { consumer_hints: { artifact: ' data/external/result ' } } }] } }));
    fs.writeFileSync(path.join(root, '.nullius/ledger.jsonl'), JSON.stringify({ run_id: 'run', event_type: 'workflow_step_completed', step_id: 'calculate' }) + '\n');
    await expectSymlinkRejection();
    fs.writeFileSync(path.join(root, '.nullius/state.json'), JSON.stringify({ run_id: 'run' }));
    fs.unlinkSync(path.join(root, '.nullius/ledger.jsonl'));
    const workspace = path.join(root, 'artifacts/runs/run/computation/nested');
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, 'logs'));
    const response = await adapter.call('orch_run_execute_manifest', { _confirm: true, run_id: 'run', run_dir: path.join(root, 'artifacts/runs/run'), manifest_path: path.join(workspace, 'manifest.json'), delivery_id: 'execute' });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain('Symlinks');
    await expect(execute(root, 'orch_run_execute_manifest', { _confirm: true, run_id: 'run', run_dir: path.join(root, 'artifacts/runs/run'), manifest_path: 'computation/nested/manifest.json' })).rejects.toThrow('Symlinks');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it('rejects a displaced root and inherited alternate control directories', async () => {
    const { root, adapter } = fixture();
    const moved = `${root}-moved`;
    roots.push(moved);
    fs.renameSync(root, moved);
    fs.mkdirSync(root);
    expect((await adapter.call('project_capabilities', {})).isError).toBe(true);
    const old = process.env.NULLIUS_CONTROL_DIR;
    try {
      process.env.NULLIUS_CONTROL_DIR = '/unrelated/control';
      expect(() => new ProjectAdapter(root)).toThrow('NULLIUS_CONTROL_DIR');
    } finally { if (old === undefined) delete process.env.NULLIUS_CONTROL_DIR; else process.env.NULLIUS_CONTROL_DIR = old; }
  });
  it('does not expose or indirectly grant operator approvals or arbitrary CLI flags', async () => {
    const { root, adapter } = fixture();
    const names = adapter.listTools().map(tool => tool.name);
    expect(names).not.toContain('orch_run_approve');
    expect(names).not.toContain('orch_run_reject');
    expect((await adapter.call('orch_run_approve', { _confirm: true })).isError).toBe(true);
    expect((await adapter.call('project_cli', { action: 'status', argv: ['approve', 'anything'] })).isError).toBe(true);
    expect((await adapter.call('orch_run_status', { project_root: path.dirname(root) })).isError).toBe(true);
    const agent = { _confirm: true, run_id: 'agent', model: 'fixture', messages: [{ role: 'user', content: 'test' }], tools: [] };
    expect(body(await adapter.call('orch_run_execute_agent', agent))).toMatchObject({ status: 'unavailable' });
    expect((await adapter.call('orch_run_execute_agent', { ...agent, team: { interventions: [{ kind: 'approve' }] } })).isError).toBe(true);
    expect((await adapter.call('orch_run_execute_agent', { ...agent, tools: [{ name: 'orch_run_approve', input_schema: {} }] })).isError).toBe(true);
  });
  it('never re-dispatches unknown attempts or lets a different delivery write concurrently', async () => {
    const { root, adapter } = fixture();
    const request: DeliveryRequest = { root, root_identity: projectIdentity(root), delivery_id: 'unknown', name: 'project_cli', args: { action: 'init' }, timeout_seconds: 300 };
    const manager = journal(root);
    manager.observeToolIntents('unknown', [attempt(request)]);
    fs.writeFileSync(requestPath(root, 'unknown'), JSON.stringify(request));
    manager.markToolIntentsDispatched('unknown', [attempt(request)]);
    acquireExecution(root, 'unknown');
    expect(body(await adapter.call('project_cli', { action: 'init', delivery_id: 'unknown' })).state).toBe('outcome_unknown');
    expect((await adapter.call('project_cli', { action: 'init', delivery_id: 'other' })).isError).toBe(true);
    expect((await adapter.call('project_file_write', { path: 'note.md', content: 'write', expected_sha256: null })).isError).toBe(true);
    expect((await adapter.call('project_cli', { action: 'notebook_sync', delivery_id: 'unknown' })).isError).toBe(true);
    expect(fs.existsSync(path.join(root, 'research_plan.md'))).toBe(false);
    releaseExecution(root, 'unknown');
  });
  it('keeps committed errors exact while paging large replies and waiting for lock release', () => {
    const { root } = fixture();
    const request: DeliveryRequest = { root, root_identity: projectIdentity(root), delivery_id: 'large', name: 'project_cli', args: { action: 'status' }, timeout_seconds: 300 };
    const manager = journal(root);
    manager.observeToolIntents('large', [attempt(request)]);
    fs.writeFileSync(requestPath(root, 'large'), JSON.stringify(request));
    manager.markToolIntentsDispatched('large', [attempt(request)]);
    acquireExecution(root, 'large');
    const result = { content: [{ type: 'text' as const, text: 'unavailable '.repeat(12_000) }], isError: true };
    commitDelivery(request, result);
    expect(readDelivery(root, 'large').state).toBe('finalizing');
    releaseExecution(root, 'large');
    const chunks: Buffer[] = [];
    let offset = 0;
    let digest = '';
    do {
      const response = readDelivery(root, 'large', offset, 1024) as Record<string, any>;
      expect(response.state).toBe('committed');
      expect(response.result).toBeNull();
      const chunk = Buffer.from(response.data, 'base64');
      expect(chunk.length).toBeLessThanOrEqual(1024);
      chunks.push(chunk);
      digest = response.response_sha256;
      if (response.next_offset === null) break;
      offset = response.next_offset;
    } while (chunks.length < 200);
    const bytes = Buffer.concat(chunks);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
    expect(JSON.parse(bytes.toString())).toEqual(result);
  });
  it('rejects a replaced project before detached execution and response commit', () => {
    const { root } = fixture();
    const request: DeliveryRequest = { root, root_identity: projectIdentity(root), delivery_id: 'moved', name: 'project_cli', args: { action: 'init' }, timeout_seconds: 300 };
    const manager = journal(root);
    manager.observeToolIntents('moved', [attempt(request)]);
    fs.writeFileSync(requestPath(root, 'moved'), JSON.stringify(request));
    manager.markToolIntentsDispatched('moved', [attempt(request)]);
    acquireExecution(root, 'moved');
    const moved = `${root}-moved`;
    roots.push(moved);
    fs.renameSync(root, moved);
    fs.cpSync(moved, root, { recursive: true });
    expect(() => readRequest(requestPath(root, 'moved'))).toThrow('identity changed');
    expect(() => commitDelivery(request, { content: [{ type: 'text', text: 'done' }] })).toThrow('identity changed');
    expect(manager.loadManifest('moved')!.checkpoints).toHaveLength(0);
    expect(fs.existsSync(path.join(moved, '.nullius/project_mcp_execution.lock'))).toBe(true);
  });
});
