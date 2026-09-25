import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { RunManifestManager, createToolAttemptIdentity } from '@nullius/orchestrator';

const server = fileURLToPath(new URL('../dist/index.js', import.meta.url));
function fixture() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-delivery-'))); }
async function connect(root: string) {
  const client = new Client({ name: 'delivery-test', version: '1.0' });
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], cwd: root, env: { ...env, NULLIUS_PROJECT_ROOT: root }, stderr: 'pipe' }));
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}
async function settle(client: Client, id: string) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const response = await call(client, 'project_delivery_read', { delivery_id: id });
    if (response.state === 'committed') return response;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Delivery ${id} did not commit`);
}
async function deliver(client: Client, name: string, args: Record<string, unknown>, id: string) {
  await call(client, name, { ...args, delivery_id: id });
  const response = await settle(client, id);
  expect(response.result.isError, JSON.stringify(response.result)).not.toBe(true);
  return JSON.parse(response.result.content[0].text);
}
function runningGroup(pgid: number): number[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  return rows.trim().split('\n').flatMap(row => {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row);
    if (!fields) throw new Error(`Cannot read process state: ${row}`);
    const [, pid, group, state] = fields;
    // An orphan may remain a zombie until the CI runner's init reaps it.
    return Number(group) === pgid && !state!.startsWith('Z') ? [Number(pid)] : [];
  });
}
describe('durable transport handoff', () => {
  it('finishes after the submitting MCP connection closes and replays across a fresh server', async () => {
    const root = fixture();
    let client = await connect(root);
    try {
      const first = await call(client, 'project_cli', { action: 'init', delivery_id: 'init' });
      expect(first.state).toBe('outcome_unknown');
      await client.close();
      client = await connect(root);
      const response = await settle(client, 'init');
      expect(response.result.isError).not.toBe(true);
      const replay = await call(client, 'project_cli', { action: 'init', delivery_id: 'init' });
      expect(replay).toEqual(response);
      expect(fs.existsSync(path.join(root, '.nullius/bin/nullius'))).toBe(true);
    } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('recovers not_started preparation without confusing it with dispatched unknown effects', async () => {
    const root = fixture();
    const args = { action: 'init' };
    const manager = new RunManifestManager(path.join(root, 'artifacts/delegated-runs/project-mcp'));
    const stat = fs.statSync(root);
    manager.observeToolIntents('prepared', [createToolAttemptIdentity({ stepId: 'call', toolName: 'project_cli', input: { project_root: root, root_identity: { dev: stat.dev, ino: stat.ino }, arguments: args, timeout_seconds: 300 } })]);
    // Simulates a crash after observation but before request bytes/dispatch.
    const client = await connect(root);
    try {
      expect((await call(client, 'project_delivery_read', { delivery_id: 'prepared' })).state).toBe('not_started');
      expect((await call(client, 'project_delivery_read', { delivery_id: 'never-submitted' })).state).toBe('missing');
      await deliver(client, 'project_cli', args, 'prepared');
      expect(manager.loadManifest('prepared')!.checkpoints).toHaveLength(1);
    } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('terminates a bounded slow computation without inventing a completed result or retrying it', async () => {
    const root = fixture();
    const client = await connect(root);
    let fixtureGroup: number | undefined;
    try {
      await deliver(client, 'project_cli', { action: 'init', mode: 'engine' }, 'init');
      await deliver(client, 'orch_run_create', { run_id: 'slow', workflow_id: 'computation' }, 'create');
      const base = 'artifacts/runs/slow/computation';
      const childScript = "from pathlib import Path; import os, time; Path('child-started.tmp').write_text('one'); os.replace('child-started.tmp', 'child-started.txt'); time.sleep(60); Path('child-finished.txt').write_text('done')";
      const script = [
        'from pathlib import Path',
        'import json, os, subprocess, sys, time',
        `child = subprocess.Popen([sys.executable, '-c', ${JSON.stringify(childScript)}])`,
        "Path('started.tmp').write_text(json.dumps({'pid': os.getpid(), 'pgid': os.getpgrp(), 'child_pid': child.pid}))",
        "os.replace('started.tmp', 'started.json')",
        'time.sleep(60)',
        "Path('finished.txt').write_text('done')",
        'child.wait()',
        '',
      ].join('\n');
      const manifest = { schema_version: 1, entry_point: { script: 'scripts/slow.py', tool: 'python' }, steps: [{ id: 'slow', script: 'scripts/slow.py', tool: 'python', timeout_minutes: 2, expected_outputs: ['finished.txt'] }], environment: { python_version: '3', platform: 'any' }, dependencies: {} };
      for (const [name, content] of [['scripts/slow.py', script], ['manifest.json', JSON.stringify(manifest)]]) {
        await call(client, 'project_file_write', { path: `${base}/${name}`, content, expected_sha256: null });
      }
      // The delivery budget includes worker/module startup. Leave room for CI
      // startup, then observe termination instead of assuming a fixed sleep did it.
      const request = { _confirm: true, run_id: 'slow', run_dir: path.join(root, 'artifacts/runs/slow'), manifest_path: 'computation/manifest.json', delivery_id: 'slow-call', timeout_seconds: 10 };
      await call(client, 'orch_run_execute_manifest', request);
      const started = path.join(root, base, 'started.json');
      const childStarted = path.join(root, base, 'child-started.txt');
      const startupDeadline = Date.now() + 20_000;
      while (!fs.existsSync(started) && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 50));
      expect(fs.existsSync(started), JSON.stringify(await call(client, 'project_delivery_read', { delivery_id: 'slow-call' }))).toBe(true);
      const identity = JSON.parse(fs.readFileSync(started, 'utf8')) as { pid: number; pgid: number; child_pid: number };
      const ownGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }));
      expect(Number.isSafeInteger(identity.pgid) && identity.pgid > 1 && identity.pgid !== ownGroup).toBe(true);
      fixtureGroup = identity.pgid;
      while (!fs.existsSync(childStarted) && Date.now() < startupDeadline) await new Promise(resolve => setTimeout(resolve, 50));
      expect(fs.readFileSync(childStarted, 'utf8')).toBe('one');
      expect(runningGroup(fixtureGroup)).toEqual(expect.arrayContaining([identity.pid, identity.child_pid]));
      const terminationDeadline = Date.now() + 20_000;
      let remaining = runningGroup(fixtureGroup);
      while (remaining.length && Date.now() < terminationDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        remaining = runningGroup(fixtureGroup);
      }
      expect(remaining, 'The worker and both fixture processes must stop before their 60-second sleeps end').toEqual([]);
      const delivered = await call(client, 'project_delivery_read', { delivery_id: 'slow-call' });
      expect(delivered.state).toBe('outcome_unknown');
      const manager = new RunManifestManager(path.join(root, 'artifacts/delegated-runs/project-mcp'));
      const beforeReplay = manager.loadManifest('slow-call')!;
      expect(beforeReplay.checkpoints).toHaveLength(0);
      expect(beforeReplay.pending_tool_intents).toEqual([expect.objectContaining({ state: 'outcome_unknown' })]);
      expect(await call(client, 'orch_run_execute_manifest', request)).toEqual(delivered);
      expect(manager.loadManifest('slow-call')).toEqual(beforeReplay);
      const retry = await client.callTool({ name: 'orch_run_execute_manifest', arguments: { ...request, delivery_id: 'unsafe-retry' } });
      expect(retry.isError).toBe(true);
      expect(JSON.parse((retry.content as Array<{ text: string }>)[0]!.text).error).toMatchObject({
        code: 'INVALID_PARAMS', message: expect.stringContaining('busy'), data: { holder: { owner: 'slow-call' } },
      });
      expect(manager.loadManifest('unsafe-retry')).toBeNull();
      expect(fs.existsSync(path.join(root, base, 'finished.txt'))).toBe(false);
      expect(fs.existsSync(path.join(root, base, 'child-finished.txt'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(started, 'utf8'))).toEqual(identity);
      expect(fs.existsSync(path.join(root, 'artifacts/delegated-runs/project-mcp/slow-call/delivery_request.json.response'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(true);
    } finally {
      // Keep failed assertions from leaving the intentionally long fixture alive.
      if (fixtureGroup !== undefined && runningGroup(fixtureGroup).length) {
        try { process.kill(-fixtureGroup, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
