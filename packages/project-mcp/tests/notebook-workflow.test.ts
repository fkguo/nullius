import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { runCli } from '@nullius/orchestrator';
import { describe, expect, it } from 'vitest';

const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Json = Record<string, any>;

// The same original-source coverage contract used by the orchestrator tests,
// executed through the real MCP worker and review-swarm transport. This runner
// supplies deterministic coverage receipts, not scientific judgment.
const reviewerTransport = String.raw`#!/usr/bin/env python3
import hashlib, json, os, re, sys
from pathlib import Path
packet = sys.stdin.read()
root = Path(os.environ['MCP_NOTEBOOK_FIXTURE_ROOT'])
if (root / 'inputs/reviewer-unavailable.txt').exists():
    print('Controlled reviewer executable cannot provide a review.', file=sys.stderr)
    sys.exit(127)
match = re.search(r'^=== ADDITIONAL CONTEXT: (.+/notebook-scope.json) ===$', packet, re.M)
assert match, 'The reviewer must receive the actual notebook scope context.'
scope_path = Path(match.group(1))
scope = json.loads(scope_path.read_text())
assert '"run_states"' in packet, 'The reviewer must receive relevant run states.'
source = (root / scope['notebook']['path']).read_text()
lines = source.split('\n')
def anchors(text, lo, hi):
    parts = text.split('\n')
    meaningful = [i for i in range(lo, hi + 1) if parts[i - 1].strip()]
    if not meaningful: return []
    line = meaningful[0]
    return [{'start_line': line, 'end_line': line, 'quote': parts[line - 1]}]
def section_anchors(section):
    start = section['start_line'] if section['heading'] == '(front matter)' else section['start_line'] + len(section['heading'].split('\n'))
    if not any(line.strip() for line in lines[start - 1:section['end_line']]): start = section['start_line']
    return anchors(source, start, section['end_line'])
sections = [{'section_id': section['section_id'], 'status': 'complete', 'anchors': section_anchors(section), 'reasoning': 'Controlled original-text coverage fixture.'} for section in scope['sections']]
dependencies = [{'path': item['path'], 'sha256': item['sha256'], 'anchors': anchors((root / item['path']).read_text(), 1, len((root / item['path']).read_text().split('\n'))), 'reasoning': 'Controlled dependency coverage fixture.'} for item in scope['dependencies']]
report = {'schema_version': 1, 'review_kind': 'notebook', 'scope_sha256': hashlib.sha256(scope_path.read_bytes()).hexdigest(), 'verdict': 'PASS', 'summary': 'Deterministic transport fixture only; no scientific conclusion.', 'coverage_status': 'complete', 'dependency_closure': 'complete', 'missing_dependencies': [], 'blocking_issues': [], 'cross_section_reasoning': 'Controlled coverage, not scientific inference.', 'sections': sections, 'dependencies': dependencies, 'opaque_sources': []}
print(json.dumps({'type': 'system', 'subtype': 'init', 'model': 'mcp-notebook-fixture'}), flush=True)
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': 'mcp-notebook-fixture', 'result': json.dumps(report)}), flush=True)
`;

function payload(raw: unknown, expectedError = false): Json {
  const result = CallToolResultSchema.parse(raw);
  expect(Boolean(result.isError), JSON.stringify(result)).toBe(expectedError);
  const block = result.content.find(item => item.type === 'text');
  if (!block || block.type !== 'text') throw new Error('Missing MCP response text.');
  return JSON.parse(block.text);
}

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-notebook-mcp-')));
  const bin = path.join(root, 'test-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), reviewerTransport, { mode: 0o755 });
  const client = new Client({ name: 'notebook-workflow-fixture', version: '1.0.0' });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: root,
    env: { ...env, PATH: bin + path.delimiter + env.PATH, NULLIUS_PROJECT_ROOT: root,
      NULLIUS_CONTROL_DIR: '', NULLIUS_HARNESS_VERIFY: 'on', MCP_NOTEBOOK_FIXTURE_ROOT: root }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const close = async () => { await client.close(); fs.rmSync(root, { recursive: true, force: true }); };
  const call = async (name: string, args: Json = {}, error = false) => payload(await client.callTool({ name, arguments: args }), error);
  const deliver = async (args: Json, id: string, error = false) => {
    let delivery = await call('project_cli', { ...args, delivery_id: id });
    const deadline = Date.now() + 30_000;
    while (['outcome_unknown', 'finalizing'].includes(delivery.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      delivery = await call('project_delivery_read', { delivery_id: id });
    }
    expect(delivery.state, JSON.stringify(delivery) + stderr).toBe('committed');
    return payload(delivery.result, error);
  };
  const read = async (name: string) => {
    const value = await call('project_file_read', { path: name });
    expect(value.next_offset).toBeNull();
    const bytes = Buffer.from(value.data, 'base64');
    expect(sha256(bytes)).toBe(value.sha256);
    return { bytes, sha256: value.sha256 as string };
  };
  const write = (name: string, content: string, expected: string | null) => call('project_file_write', { path: name, content, expected_sha256: expected });
  const review = (id: string, error = false) => deliver({ action: 'notebook_review', model: 'claude/mcp-notebook-fixture', review_timeout_seconds: 20 }, id, error);
  const deliveries = () => fs.readdirSync(path.join(root, 'artifacts/delegated-runs/project-mcp')).sort();
  try {
    await client.connect(transport);
    expect((await deliver({ action: 'init', mode: 'file' }, 'init-project')).exit_code).toBe(0);
    expect((await call('project_cli', { action: 'status' })).exit_code).toBe(0);
    return { root, client, close, call, deliver, read, write, review, deliveries };
  } catch (error) { await close(); throw error; }
}

const notebook = '# 研究笔记\n\n## 当前问题\n研究假设的适用范围，以及早期路线为什么没有成为最终结论。\n\n## 辅助推导与局限\n[原始辅助前提](artifacts/runs/aux-premise/inputs/premise.md)仅用于说明旧路线，当前科学结论仍需独立证据。\n';

describe('user notebook workflow over actual project MCP stdio', () => {
  it('authors with CAS, executes typed review delivery and withdraws stale acceptance', async () => {
    const project = await fixture();
    const { root, call, deliver, read, write, review, deliveries } = project;
    try {
      const scaffold = await read('research_notebook.md');
      expect(scaffold.bytes.toString()).not.toContain('NOTEBOOK_CURRENT_STATE_');
      await write('artifacts/runs/aux-premise/inputs/premise.md', '# 辅助前提\n\n变量的定义域是实数。\n', null);
      expect((await deliver({ action: 'trace', run_id: 'aux-premise' }, 'stamp-auxiliary')).exit_code).toBe(0);
      const authored = await write('research_notebook.md', notebook, scaffold.sha256);
      expect(authored.sha256).toBe(sha256(notebook));
      const staleWrite = await call('project_file_write', { path: 'research_notebook.md', content: 'Must not replace the author text.', expected_sha256: scaffold.sha256 }, true);
      expect(staleWrite.error.code).toBe('INVALID_PARAMS');
      expect((await read('research_notebook.md')).bytes.toString()).toBe(notebook);

      const beforeCheck = deliveries();
      const missing = await call('project_cli', { action: 'notebook_check' }, true);
      expect(missing).toMatchObject({ exit_code: 1, data: { status: 'incomplete', content_review: { status: 'missing' } } });
      expect(deliveries()).toEqual(beforeCheck);
      expect((await read('research_notebook.md')).sha256).toBe(authored.sha256);

      const short = await call('project_cli', { action: 'notebook_review', model: 'claude/mcp-notebook-fixture',
        review_timeout_seconds: 20, timeout_seconds: 79, delivery_id: 'insufficient-budget' }, true);
      expect(short.error.code).toBe('INVALID_PARAMS');
      expect(fs.existsSync(path.join(root, 'artifacts/delegated-runs/project-mcp/insufficient-budget'))).toBe(false);
      expect((await call('project_delivery_read', { delivery_id: 'insufficient-budget' })).state).toBe('missing');

      const reviewed = await review('review-notes');
      expect(reviewed).toMatchObject({ exit_code: 0, data: { status: 'accepted' } });
      const reviewId = reviewed.data.run_id;
      const request = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/delegated-runs/project-mcp/review-notes/delivery_request.json'), 'utf8'));
      expect(request.timeout_seconds).toBe(80);
      expect(request.args.review_timeout_seconds).toBe(20);
      expect(request.args).not.toHaveProperty('timeout_seconds');
      const receipt = JSON.parse((await read(`artifacts/runs/${reviewId}/review_execution.json`)).bytes.toString());
      expect(receipt.command[receipt.command.indexOf('--timeout-secs') + 1]).toBe('20');
      const scope = JSON.parse((await read(`artifacts/runs/${reviewId}/inputs/notebook-scope.json`)).bytes.toString());
      expect(scope.run_states).toMatchObject([{ run_id: 'aux-premise', state: { validity: 'active', stamped: true } }]);
      const afterReview = deliveries();
      const accepted = await call('project_cli', { action: 'notebook_check' });
      expect(accepted).toMatchObject({ exit_code: 0, data: { status: 'accepted', structure: { status: 'not_applicable' }, content_review: { status: 'accepted' } } });
      expect(deliveries()).toEqual(afterReview);
      expect((await read('research_notebook.md')).sha256).toBe(authored.sha256);

      const revised = notebook + '\n## 后续问题\n需要检验边界条件变化是否影响旧近似。\n';
      const updated = await write('research_notebook.md', revised, authored.sha256);
      const changed = await call('project_cli', { action: 'notebook_check' }, true);
      expect(changed).toMatchObject({ exit_code: 1, data: { status: 'incomplete', content_review: { status: 'stale' } } });
      expect((await review('review-revised-notes')).exit_code).toBe(0);

      // Simulate an independent external ledger update through the existing
      // CLI. Authoring, review and all acceptance observations remain MCP-only.
      let voidError = '';
      expect(await runCli(['--project-root', root, 'trace', 'void', 'aux-premise', '--reason', 'auxiliary premise invalidated'],
        { cwd: root, stdout: () => {}, stderr: text => { voidError += text; } }), voidError).toBe(0);
      expect((await read('research_notebook.md')).sha256).toBe(updated.sha256);
      const invalidated = await call('project_cli', { action: 'notebook_check' }, true);
      expect(invalidated).toMatchObject({ exit_code: 1, data: { content_review: { status: 'stale', reason: expect.stringContaining('Referenced run validity or identity changed') } } });
      expect((await review('review-current-history')).exit_code).toBe(0);
      expect((await call('project_cli', { action: 'notebook_check' })).data.status).toBe('accepted');
    } finally { await project.close(); }
  }, 90_000);

  it('does not inherit old acceptance when the reviewer executable cannot deliver a report', async () => {
    const project = await fixture();
    try {
      const scaffold = await project.read('research_notebook.md');
      const text = '# 用户研究笔记\n\n## 推导\n保留原始定义、推导和尚未解决的适用范围问题。\n';
      await project.write('research_notebook.md', text, scaffold.sha256);
      expect((await project.review('first-review')).exit_code).toBe(0);
      await project.write('inputs/reviewer-unavailable.txt', 'Controlled unavailable transport; never contact an external model.\n', null);
      const failed = await project.review('unavailable-review', true);
      expect(failed).toMatchObject({ exit_code: 2, data: { status: 'unavailable' } });
      const current = await project.call('project_cli', { action: 'notebook_check' }, true);
      expect(current).toMatchObject({ exit_code: 2, data: { status: 'unavailable', content_review: { status: 'unavailable' } } });
      expect((await project.read('research_notebook.md')).bytes.toString()).toBe(text);
    } finally { await project.close(); }
  }, 60_000);
});
