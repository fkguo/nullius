import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
    try {
      await deliver(client, 'project_cli', { action: 'init', mode: 'engine' }, 'init');
      await deliver(client, 'orch_run_create', { run_id: 'slow', workflow_id: 'computation' }, 'create');
      const base = 'artifacts/runs/slow/computation';
      const script = "from pathlib import Path\nimport time\nPath('started.txt').write_text('one')\ntime.sleep(15)\nPath('finished.txt').write_text('done')\n";
      const manifest = { schema_version: 1, entry_point: { script: 'scripts/slow.py', tool: 'python' }, steps: [{ id: 'slow', script: 'scripts/slow.py', tool: 'python', timeout_minutes: 1, expected_outputs: ['finished.txt'] }], environment: { python_version: '3', platform: 'any' }, dependencies: {} };
      for (const [name, content] of [['scripts/slow.py', script], ['manifest.json', JSON.stringify(manifest)]]) {
        await call(client, 'project_file_write', { path: `${base}/${name}`, content, expected_sha256: null });
      }
      const request = { _confirm: true, run_id: 'slow', run_dir: path.join(root, 'artifacts/runs/slow'), manifest_path: 'computation/manifest.json', delivery_id: 'slow-call', timeout_seconds: 2 };
      await call(client, 'orch_run_execute_manifest', request);
      const deadline = Date.now() + 2500;
      while (!fs.existsSync(path.join(root, base, 'started.txt')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      expect(fs.existsSync(path.join(root, base, 'started.txt')), JSON.stringify(await call(client, 'project_delivery_read', { delivery_id: 'slow-call' }))).toBe(true);
      expect(fs.readFileSync(path.join(root, base, 'started.txt'), 'utf8')).toBe('one');
      await new Promise(resolve => setTimeout(resolve, 2300));
      const delivered = await call(client, 'project_delivery_read', { delivery_id: 'slow-call' });
      expect(delivered.state).toBe('outcome_unknown');
      expect(await call(client, 'orch_run_execute_manifest', request)).toEqual(delivered);
      expect((await client.callTool({ name: 'orch_run_execute_manifest', arguments: { ...request, delivery_id: 'unsafe-retry' } })).isError).toBe(true);
      expect(fs.existsSync(path.join(root, base, 'finished.txt'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.nullius/project_mcp_execution.lock'))).toBe(true);
    } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
