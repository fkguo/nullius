import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalJson,
  createToolAttemptIdentity,
  RunManifestManager,
  sha256McpToolResult,
  type RunManifest,
} from '../src/run-manifest.js';
import type { McpToolResult } from '../src/mcp-client.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-manifest-test-'));
}

const RESULT: McpToolResult = {
  ok: true,
  isError: false,
  rawText: 'result text',
  json: { z: 2, a: 1 },
  errorCode: null,
};

interface ClaimWorkerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function waitForChild(child: ChildProcess): Promise<ClaimWorkerResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForFiles(paths: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every(candidate => fs.existsSync(candidate))) {
    if (Date.now() >= deadline) {
      throw new Error(`claim workers did not reach barrier: ${paths.join(', ')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('RunManifestManager v2 tool-attempt journal', () => {
  let tmpDir: string;
  let manager: RunManifestManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    manager = new RunManifestManager(path.join(tmpDir, 'runs'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates version 2 before execution and records a canonical input identity', () => {
    const attempt = createToolAttemptIdentity({ stepId: 'step-0', toolName: 'tool_a', input: { z: 2, a: 1 } });
    const reordered = createToolAttemptIdentity({ stepId: 'step-0', toolName: 'tool_a', input: { a: 1, z: 2 } });

    expect(attempt.input_sha256).toBe(reordered.input_sha256);
    manager.observeToolIntents('run-1', [attempt]);

    expect(manager.loadManifest('run-1')).toMatchObject({
      manifest_version: 2,
      run_id: 'run-1',
      pending_tool_intents: [{ ...attempt, state: 'not_started', approval_boundary_count: 0 }],
      checkpoints: [],
    });
  });

  it('moves not_started -> outcome_unknown -> committed and replays the exact result', () => {
    const attempt = createToolAttemptIdentity({ stepId: 'step-0', toolName: 'tool_a', input: {} });
    manager.observeToolIntents('run-1', [attempt]);
    manager.markToolIntentsDispatched('run-1', [attempt]);
    expect(manager.classifyToolAttempt('run-1', attempt)).toMatchObject({ state: 'outcome_unknown' });

    manager.commitToolAttempt('run-1', attempt, RESULT);
    const classification = manager.classifyToolAttempt('run-1', attempt);
    expect(classification).toEqual({
      state: 'committed',
      identity: attempt,
      result: RESULT,
      result_sha256: sha256McpToolResult(RESULT),
    });
    expect(manager.loadManifest('run-1')).toMatchObject({
      last_completed_step: 'step-0',
      pending_tool_intents: [],
      checkpoints: [{
        ...attempt,
        result_sha256: sha256McpToolResult(RESULT),
        outcome: {
          ok: true,
          is_error: false,
          raw_text: 'result text',
          json: { z: 2, a: 1 },
          error_code: null,
        },
      }],
    });
  });

  it('persists batch observation and dispatch as all-at-once transitions', () => {
    const attempts = [
      createToolAttemptIdentity({ stepId: 'step-a', toolName: 'tool_a', input: {} }),
      createToolAttemptIdentity({ stepId: 'step-b', toolName: 'tool_b', input: { n: 1 } }),
    ];
    manager.observeToolIntents('run-batch', attempts);
    manager.markToolIntentsDispatched('run-batch', attempts);

    expect(manager.classifyToolAttempts('run-batch', attempts).map(item => item.state))
      .toEqual(['outcome_unknown', 'outcome_unknown']);
    const runDir = path.join(tmpDir, 'runs', 'run-batch');
    expect(fs.readdirSync(runDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('grants a dispatch claim exactly once across manager instances', () => {
    const contender = new RunManifestManager(path.join(tmpDir, 'runs'));
    const attempt = createToolAttemptIdentity({ stepId: 'step-race', toolName: 'tool_a', input: {} });
    manager.observeToolIntents('run-race', [attempt]);

    // Both processes can observe the same pre-claim snapshot. Only the first
    // locked compare-and-claim may transition it to outcome_unknown.
    expect(manager.classifyToolAttempt('run-race', attempt).state).toBe('not_started');
    expect(contender.classifyToolAttempt('run-race', attempt).state).toBe('not_started');
    manager.markToolIntentsDispatched('run-race', [attempt]);
    expect(() => contender.markToolIntentsDispatched('run-race', [attempt]))
      .toThrow(/already owned by another execution/);
    expect(contender.classifyToolAttempt('run-race', attempt).state).toBe('outcome_unknown');
  });

  it('grants exactly one dispatch claim when two OS processes cross the same barrier', async () => {
    const attempt = createToolAttemptIdentity({
      stepId: 'step-process-race',
      toolName: 'tool_a',
      input: { value: 1 },
    });
    manager.observeToolIntents('run-process-race', [attempt]);

    const builtModuleUrl = pathToFileURL(path.resolve(
      fileURLToPath(new URL('..', import.meta.url)),
      'dist/run-manifest.js',
    )).href;
    const workerPath = path.join(tmpDir, 'claim-worker.mjs');
    fs.writeFileSync(workerPath, `
      import * as fs from 'node:fs';
      import { RunManifestManager } from ${JSON.stringify(builtModuleUrl)};

      const runsDir = process.env['CLAIM_RUNS_DIR'];
      const runId = process.env['CLAIM_RUN_ID'];
      const attemptJson = process.env['CLAIM_ATTEMPT_JSON'];
      const readyPath = process.env['CLAIM_READY_PATH'];
      const releasePath = process.env['CLAIM_RELEASE_PATH'];
      if (!runsDir || !runId || !attemptJson || !readyPath || !releasePath) {
        throw new Error('claim worker environment is incomplete');
      }
      const attempt = JSON.parse(attemptJson);
      fs.writeFileSync(readyPath, String(process.pid), { flag: 'wx' });
      const waitCell = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(releasePath)) {
        if (Date.now() >= deadline) throw new Error('claim worker barrier timed out');
        Atomics.wait(waitCell, 0, 0, 10);
      }

      try {
        new RunManifestManager(runsDir).markToolIntentsDispatched(runId, [attempt]);
        process.stdout.write(JSON.stringify({ pid: process.pid, outcome: 'claimed' }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('already owned by another execution')) throw error;
        process.stdout.write(JSON.stringify({ pid: process.pid, outcome: 'already_owned', message }));
      }
    `);

    const releasePath = path.join(tmpDir, 'claim-release');
    const readyPaths = [
      path.join(tmpDir, 'claim-ready-0'),
      path.join(tmpDir, 'claim-ready-1'),
    ];
    const workers = readyPaths.map(readyPath => spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        CLAIM_RUNS_DIR: path.join(tmpDir, 'runs'),
        CLAIM_RUN_ID: 'run-process-race',
        CLAIM_ATTEMPT_JSON: JSON.stringify(attempt),
        CLAIM_READY_PATH: readyPath,
        CLAIM_RELEASE_PATH: releasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const completions = workers.map(waitForChild);

    try {
      await Promise.race([
        waitForFiles(readyPaths, 10_000),
        ...completions.map((completion, index) => completion.then(result => {
          throw new Error(
            `claim worker ${index} exited before barrier: `
            + `code=${String(result.code)} signal=${String(result.signal)} `
            + `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
          );
        })),
      ]);
      const workerPids = readyPaths.map(readyPath => Number(fs.readFileSync(readyPath, 'utf-8')));
      expect(new Set(workerPids).size).toBe(2);
      expect(workerPids).not.toContain(process.pid);

      fs.writeFileSync(releasePath, 'go', { flag: 'wx' });
      const results = await Promise.all(completions);
      expect(results.map(result => ({ code: result.code, signal: result.signal, stderr: result.stderr })))
        .toEqual([
          { code: 0, signal: null, stderr: '' },
          { code: 0, signal: null, stderr: '' },
        ]);
      const claims = results.map(result => JSON.parse(result.stdout) as {
        pid: number;
        outcome: 'claimed' | 'already_owned';
        message?: string;
      });
      expect(claims.map(claim => claim.outcome).sort()).toEqual(['already_owned', 'claimed']);
      expect(claims.find(claim => claim.outcome === 'already_owned')?.message)
        .toMatch(/already owned by another execution/);
      expect(manager.classifyToolAttempt('run-process-race', attempt).state).toBe('outcome_unknown');
      expect(fs.existsSync(path.join(
        tmpDir,
        'runs/run-process-race/manifest.json.lock',
      ))).toBe(false);
    } finally {
      for (const worker of workers) {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      }
      await Promise.allSettled(completions);
    }
  }, 20_000);

  it('treats observation and same-result commit as idempotent but rejects conflicts', () => {
    const attempt = createToolAttemptIdentity({ stepId: 'step-0', toolName: 'tool_a', input: { n: 1 } });
    manager.observeToolIntents('run-1', [attempt]);
    manager.observeToolIntents('run-1', [attempt]);
    manager.markToolIntentsDispatched('run-1', [attempt]);
    manager.commitToolAttempt('run-1', attempt, RESULT);
    manager.commitToolAttempt('run-1', attempt, RESULT);

    expect(manager.loadManifest('run-1')?.checkpoints).toHaveLength(1);
    expect(() => manager.observeToolIntents('run-1', [
      createToolAttemptIdentity({ stepId: 'step-0', toolName: 'tool_b', input: { n: 1 } }),
    ])).toThrow(/identity conflict/);
    expect(() => manager.commitToolAttempt('run-1', attempt, { ...RESULT, rawText: 'different' }))
      .toThrow(/result conflict/);
  });

  it('records a validated approval boundary and safely resets the next attempt to not_started', () => {
    const attempt = createToolAttemptIdentity({ stepId: 'step-approval', toolName: 'approval_tool', input: {} });
    manager.observeToolIntents('run-1', [attempt]);
    manager.markToolIntentsDispatched('run-1', [attempt]);
    manager.resetOutcomeUnknownAtApprovalBoundary('run-1', attempt, {
      authority: 'run_gate',
      gate_id: 'A3',
      run_id: 'run-1',
      approval_id: 'A3-0001',
      packet_path: 'artifacts/runs/run-1/approval.json',
      approval_packet_sha256: 'a'.repeat(64),
    });

    expect(manager.classifyToolAttempt('run-1', attempt)).toMatchObject({ state: 'not_started' });
    expect(manager.loadManifest('run-1')?.pending_tool_intents[0]).toMatchObject({
      state: 'not_started',
      approval_boundary_count: 1,
      last_approval_boundary: {
        authority: 'run_gate',
        approval_id: 'A3-0001',
        approval_packet_sha256: 'a'.repeat(64),
      },
    });

    manager.markToolIntentsDispatched('run-1', [attempt]);
    manager.commitToolAttempt('run-1', attempt, RESULT);
    expect(manager.loadManifest('run-1')?.checkpoints[0]).toMatchObject({
      approval_boundary_count: 1,
      last_approval_boundary: {
        authority: 'run_gate',
        approval_id: 'A3-0001',
        approval_packet_sha256: 'a'.repeat(64),
      },
    });
  });

  it('fails closed on missing intents, non-canonical inputs, and legacy manifests', () => {
    const attempt = createToolAttemptIdentity({ stepId: 'step-0', toolName: 'tool_a', input: {} });
    expect(manager.classifyToolAttempt('missing-run', attempt)).toEqual({ state: 'missing', identity: attempt });
    expect(() => canonicalJson({ value: undefined })).toThrow(/rejects undefined/);

    const runDir = path.join(tmpDir, 'runs', 'legacy');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
      run_id: 'legacy',
      created_at: '2026-01-01T00:00:00Z',
      checkpoints: [],
    }));
    expect(() => manager.loadManifest('legacy')).toThrow(/manifest_version 2/);
  });

  it('rejects unsafe run ids before resolving a manifest path', () => {
    expect(() => manager.ensureManifest('../outside')).toThrow(/invalid delegated runtime run_id/);
    expect(() => manager.loadManifest('/absolute')).toThrow(/invalid delegated runtime run_id/);
    expect(fs.existsSync(path.join(tmpDir, 'outside', 'manifest.json'))).toBe(false);
  });

  it('rejects a manifest that claims the same step is pending and committed', () => {
    const attempt = createToolAttemptIdentity({ stepId: 'step-0', toolName: 'tool_a', input: {} });
    const invalid: RunManifest = {
      manifest_version: 2,
      run_id: 'invalid',
      created_at: '2026-01-01T00:00:00Z',
      pending_tool_intents: [{
        ...attempt,
        state: 'not_started',
        observed_at: '2026-01-01T00:00:00Z',
        approval_boundary_count: 0,
      }],
      checkpoints: [{
        ...attempt,
        completed_at: '2026-01-01T00:00:01Z',
        result_sha256: sha256McpToolResult(RESULT),
        outcome: {
          ok: RESULT.ok,
          is_error: RESULT.isError,
          raw_text: RESULT.rawText,
          json: RESULT.json,
          error_code: RESULT.errorCode,
        },
        approval_boundary_count: 0,
      }],
    };
    const runDir = path.join(tmpDir, 'runs', 'invalid');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(invalid));
    expect(() => manager.loadManifest('invalid')).toThrow(/both pending and committed/);
  });
});
