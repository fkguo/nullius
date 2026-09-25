import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const SERVER_PATH = fileURLToPath(new URL('../dist/index.js', import.meta.url));
type Json = Record<string, any>;

function payload(result: any): Json {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const block = result.content?.find((item: any) => item.type === 'text');
  expect(block, 'MCP tool must return its actual response').toBeDefined();
  return JSON.parse(block.text);
}

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

// An arithmetic transport fixture, not evidence of scientific independence.
// Production adds ten integers; the checker uses their closed-form sum and
// actively rejects a perturbed value before it emits a typed verdict.
const PRODUCTION_SCRIPT = [
  'import json',
  'from pathlib import Path',
  "Path('results').mkdir(parents=True, exist_ok=True)",
  "Path('results/result.json').write_text(json.dumps({'n': 10, 'value': sum(range(1, 11))}) + '\\n', encoding='utf-8')",
  '',
].join('\n');

const CHECKER_SCRIPT = [
  'import argparse, hashlib, json',
  'from pathlib import Path',
  'p = argparse.ArgumentParser()',
  "p.add_argument('--nullius-request', required=True)",
  "p.add_argument('--nullius-verdict', required=True)",
  'a = p.parse_args()',
  'request_bytes = Path(a.nullius_request).read_bytes()',
  'request = json.loads(request_bytes)',
  "targets = request['output_targets']",
  'assert len(targets) == 1',
  "output_bytes = Path(targets[0]['path']).read_bytes()",
  'output = json.loads(output_bytes)',
  "expected = output['n'] * (output['n'] + 1) // 2",
  'def passes(value):',
  '    return value == expected',
  "negative_ok = not passes(output['value'] + 1)",
  "ok = output['n'] == 10 and passes(output['value']) and negative_ok",
  "observations = [{'uri': targets[0]['uri'], 'path': targets[0]['path'], 'sha256': hashlib.sha256(output_bytes).hexdigest()}]",
  "verdict = {'schema_version': 1, 'request_sha256': hashlib.sha256(request_bytes).hexdigest(), 'check_kind': request['check_kind'], 'status': 'pass' if ok else 'fail', 'summary': 'The ten-integer sum is 55 and a shifted value is rejected.' if ok else 'Arithmetic fixture failed.', 'quantity_id': request['quantity_id'], 'layer_id': request['layer_id'], 'disputed_dimensions': request['disputed_dimensions'], 'consumed_output_observations': observations, 'negative_control_results': [{'control_id': control_id, 'status': 'pass' if negative_ok else 'fail'} for control_id in request['required_negative_control_ids']]}",
  "Path(a.nullius_verdict).write_text(json.dumps(verdict, indent=2) + '\\n', encoding='utf-8')",
  'raise SystemExit(0 if ok else 1)',
  '',
].join('\n');

function methodHandoff(corruptOutput = false): Json {
  return {
    campaign_id: 'cccccc01', node_id: 'nnnnnn02', idea_id: 'dddddd03',
    promoted_at: '2026-09-24T00:00:00Z',
    grounding_audit: {
      status: 'pass', folklore_risk_score: 0, failures: [],
      timestamp: '2026-09-24T00:00:00Z',
    },
    idea_card: {
      thesis_statement: 'Exercise the real project transport with a bounded arithmetic fixture.',
      testable_hypotheses: ['The first ten positive integers sum to 55.'],
      required_observables: ['integer_sum'],
      minimal_compute_plan: [{ step: 'Sum ten integers', method: 'finite addition', estimated_difficulty: 'low' }],
      claims: [{ claim_text: 'This is an integration-test fixture, not a research conclusion.', support_type: 'derivation', evidence_uris: [] }],
      method_spec: {
        files: [{
          path: 'scripts/sum.py',
          content: corruptOutput ? PRODUCTION_SCRIPT.replace('sum(range(1, 11))', 'sum(range(1, 11)) + 1') : PRODUCTION_SCRIPT,
        }],
        run_card: {
          schema_version: 2, run_id: 'arithmetic-method', workflow_id: 'computation',
          title: 'Bounded integer summation',
          phases: [{
            phase_id: 'sum_integers',
            backend: { kind: 'shell', argv: ['python3', 'scripts/sum.py'], cwd: '.', timeout_seconds: 30 },
            outputs: ['results/result.json'],
          }],
        },
      },
    },
  };
}

describe('project MCP research loop over real stdio', () => {
  it.each([
    { corruptOutput: false, scenario: 'registers a checked result without replaying its computation' },
    { corruptOutput: true, scenario: 'rejects an operator pass when the actual production output is wrong' },
  ])('$scenario', async ({ corruptOutput }) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-project-mcp-loop-')));
    const runId = 'arithmetic-run';
    const runRelative = `artifacts/runs/${runId}`;
    const runDir = path.join(root, runRelative);
    const client = new Client({ name: 'nullius-research-loop-test', version: '1.0.0' });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({
      command: process.execPath, args: [SERVER_PATH], cwd: root,
      env: { ...env, NULLIUS_PROJECT_ROOT: root }, stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    try {
      await client.connect(transport);
      const call = async (name: string, args: Json = {}): Promise<Json> => payload(await client.callTool({ name, arguments: args }));
      const deliverRaw = async (name: string, args: Json, deliveryId: string): Promise<Json> => {
        let delivery = await call(name, { ...args, delivery_id: deliveryId });
        const deadline = Date.now() + 45_000;
        while (['outcome_unknown', 'finalizing'].includes(delivery.state) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
          delivery = await call('project_delivery_read', { delivery_id: deliveryId });
        }
        expect(delivery.state, JSON.stringify(delivery) + stderr).toBe('committed');
        return delivery.result;
      };
      const deliver = async (name: string, args: Json, deliveryId: string): Promise<Json> => payload(await deliverRaw(name, args, deliveryId));
      const read = async (relativePath: string): Promise<{ bytes: Buffer; sha: string }> => {
        const chunks: Buffer[] = [];
        let offset = 0;
        let digest: string | undefined;
        do {
          const file = await call('project_file_read', { path: relativePath, offset, max_bytes: 65536 });
          if (digest !== undefined) expect(file.sha256).toBe(digest);
          digest = file.sha256;
          chunks.push(Buffer.from(file.data, 'base64'));
          if (file.next_offset === null || file.next_offset === undefined) break;
          expect(file.next_offset).toBeGreaterThan(offset);
          offset = file.next_offset;
        } while (chunks.length < 100);
        const bytes = Buffer.concat(chunks);
        expect(sha256(bytes)).toBe(digest);
        return { bytes, sha: digest! };
      };
      const write = (relativePath: string, content: string) => call('project_file_write', {
        path: relativePath, content, expected_sha256: null,
      });

      // Full init supplies the canonical scaffold and exact Git identity;
      // bypassing it with handwritten .nullius state would miss the contract.
      await deliver('project_cli', { action: 'init', mode: 'engine' }, 'init-project');
      expect(fs.readFileSync(path.join(root, '.nullius', 'HARNESS')).length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, '.nullius', 'bin', 'nullius'))).toBe(true);
      await deliver('orch_run_create', { run_id: runId, workflow_id: 'computation' }, 'create-run');
      await write('inputs/method-handoff.json', JSON.stringify(methodHandoff(corruptOutput), null, 2) + '\n');
      await deliver('orch_run_stage_idea', {
        run_id: runId, run_dir: runDir, handoff_path: path.join(root, 'inputs/method-handoff.json'),
      }, 'stage-method');
      const plan = await deliver('orch_run_plan_computation', {
        run_id: runId, run_dir: runDir, dry_run: false,
      }, 'plan-method');
      expect(plan).toMatchObject({ status: 'planned', requires_approval: false, manifest_path: 'computation/manifest.json' });
      const manifest = await read(`${runRelative}/computation/manifest.json`);
      expect(JSON.parse(manifest.bytes.toString()).entry_point.script).toBe('scripts/sum.py');

      const executeArgs = { _confirm: true, run_id: runId, run_dir: runDir, manifest_path: plan.manifest_path };
      const executed = await deliver('orch_run_execute_manifest', executeArgs, 'execute-method');
      expect(executed).toMatchObject({ status: 'completed', run_id: runId });
      const production = await read(`${runRelative}/computation/results/result.json`);
      expect(JSON.parse(production.bytes.toString())).toEqual({ n: 10, value: corruptOutput ? 56 : 55 });
      const executionStatus = await read(`${runRelative}/computation/execution_status.json`);
      expect(await deliver('orch_run_execute_manifest', executeArgs, 'execute-method')).toEqual(executed);
      expect((await read(`${runRelative}/computation/execution_status.json`)).sha).toBe(executionStatus.sha);

      // Only the checker source is uploaded; production result, typed subject,
      // verdict, coverage and validation receipts must all be core-generated.
      await write(`${runRelative}/verification/check.py`, CHECKER_SCRIPT);
      const canonicalPaths = ['computation_result_v1.json', 'verification_subject_verdict_computation_result_v1.json', 'verification_coverage_v1.json'];
      const beforeVerification = await Promise.all(canonicalPaths.map(name => read(`${runRelative}/artifacts/${name}`)));
      const verificationEnvelope = await deliverRaw('orch_run_record_verification', {
        run_id: runId, status: 'passed', summary: 'Check the arithmetic transport fixture.',
        evidence_paths: ['computation/results/result.json'],
        checker_path: 'verification/check.py', checker_runtime: 'python3', checker_helper_paths: [],
        quantity_id: 'quantity:integer-sum', layer_id: 'layer:production-output',
        reference_provenance: [{
          reference_id: 'reference:input-manifest',
          uri: `rep://runs/${runId}/artifact/${encodeURIComponent('computation/manifest.json')}`,
          sha256: manifest.sha,
        }],
        disputed_dimensions: ['integer-value'], required_negative_control_ids: ['negative-control:shifted-value'],
        confidence_level: 'high',
      }, 'verify-output');
      if (corruptOutput) {
        expect(verificationEnvelope.isError).toBe(true);
        expect(verificationEnvelope.content[0].text).toMatch(/cannot replace or upgrade the directly executed checker verdict/);
        const emitted = JSON.parse((await read(`${runRelative}/artifacts/validation-chain/checker_verdict_v1.json`)).bytes.toString());
        expect(emitted).toMatchObject({ status: 'fail', summary: 'Arithmetic fixture failed.' });
        expect(emitted.consumed_output_observations).toEqual([expect.objectContaining({ sha256: production.sha })]);
        // An invalid operator expectation must not rewrite canonical evidence
        // into a success; the executed checker's failing verdict remains readable.
        const afterVerification = await Promise.all(canonicalPaths.map(name => read(`${runRelative}/artifacts/${name}`)));
        expect(afterVerification.map(file => file.sha)).toEqual(beforeVerification.map(file => file.sha));
        expect(JSON.parse(afterVerification[0]!.bytes.toString()).verification_refs.check_run_refs).toBeUndefined();
        expect(JSON.parse(afterVerification[1]!.bytes.toString()).status).toBe('not_attempted');
        expect(JSON.parse(afterVerification[2]!.bytes.toString()).summary.subjects_verified).toBe(0);
        const final = await deliver('orch_run_request_final_conclusions', { run_id: runId }, 'evaluate-final');
        expect(final).toMatchObject({ gate_id: 'A5', gate_decision: 'unavailable', requires_approval: false, ready_for_final_conclusions: false });
        const status = await call('orch_run_status');
        expect(status.pending_approval).toBeNull();
        expect(status.traceability.results.current).toEqual([]);
        return;
      }
      const verification = payload(verificationEnvelope);
      expect(verification.status).toBe('passed');
      const result = JSON.parse((await read(`${runRelative}/artifacts/computation_result_v1.json`)).bytes.toString());
      expect(result.verification_refs.check_run_refs).toEqual([expect.objectContaining({ kind: 'verification_check_run' })]);
      const check = JSON.parse((await read(`${runRelative}/artifacts/verification_check_run_computation_result_v1.json`)).bytes.toString());
      expect(check.summary).toBe('The ten-integer sum is 55 and a shifted value is rejected.');
      const final = await deliver('orch_run_request_final_conclusions', { run_id: runId }, 'evaluate-final');
      expect(final).toMatchObject({ gate_id: 'A5', gate_decision: 'unavailable', ready_for_final_conclusions: false });

      await deliver('project_cli', {
        action: 'result_set_current', result_id: 'integer-sum', run_id: runId,
        artifact: `${runRelative}/computation/results/result.json`, description: 'Bounded arithmetic integration fixture',
      }, 'register-result');
      await deliver('project_cli', { action: 'notebook_sync' }, 'sync-notebook');
      await deliver('project_cli', { action: 'index_sync' }, 'sync-index');
      const status = await call('orch_run_status');
      expect(status).toMatchObject({ run_id: runId, run_status: 'completed', pending_approval: null });
      expect(status.traceability.results.current).toEqual([expect.objectContaining({ result_id: 'integer-sum', run_id: runId, defective: false })]);
      expect((await read('project_index.md')).bytes.toString()).toContain('integer-sum');
      const notebook = (await read('research_notebook.md')).bytes.toString();
      expect(notebook).toContain('<!-- NOTEBOOK_CURRENT_STATE_START -->');
      expect(notebook).toContain('integer-sum');
      const current = await call('project_cli', { action: 'current' });
      expect(current.exit_code).toBe(0);
      expect(current.data.results.current).toEqual([expect.objectContaining({ result_id: 'integer-sum', run_id: runId })]);
    } finally {
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
