import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ArtifactRefV1 } from '@nullius/shared';
import { runCli } from '../src/cli.js';
import { buildProductionEnvironment } from '../src/computation/dependency-closure.js';
import type { NativeRuntimeIdentity } from '../src/computation/runtime-identity.js';
import { handleOrchRunRequestFinalConclusions } from '../src/orch-tools/final-conclusions.js';
import { handleOrchRunRecordVerification } from '../src/orch-tools/verification.js';
import { StateManager } from '../src/state-manager.js';

type CheckerStatus = 'pass' | 'fail' | 'blocked';

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function artifactRef(runId: string, runDir: string, filePath: string, kind: string): ArtifactRefV1 {
  const relativePath = path.relative(runDir, filePath).split(path.sep).join('/');
  return {
    uri: `rep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(relativePath)}`,
    sha256: sha256File(filePath),
    kind,
    size_bytes: fs.statSync(filePath).size,
    produced_by: 'test-fixture',
  };
}

function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stderr: (text: string) => stderr.push(text),
      stdout: (text: string) => stdout.push(text),
    },
    stderr,
    stdout,
  };
}

async function prepareCompletedRun() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-validation-chain-'));
  const runId = 'validation-chain-run';
  const runDir = path.join(projectRoot, runId);
  const computationDir = path.join(runDir, 'computation');
  const entryPath = path.join(computationDir, 'entry.py');
  const helperPath = path.join(computationDir, 'helper.py');
  const dataPath = path.join(computationDir, 'data.txt');
  const lockPath = path.join(computationDir, 'requirements.lock');
  const postPath = path.join(computationDir, 'post.py');
  const manifestPath = path.join(computationDir, 'manifest.json');
  fs.mkdirSync(computationDir, { recursive: true });
  fs.writeFileSync(
    entryPath,
    "import json, sys\nfrom pathlib import Path\nfrom helper import VALUE\ndata = Path(sys.argv[1]).read_text(encoding='utf-8').strip()\nPath('result.json').write_text(json.dumps({'value': VALUE, 'data': data}) + '\\n', encoding='utf-8')\n",
    'utf-8',
  );
  fs.writeFileSync(helperPath, 'VALUE = 1\n', 'utf-8');
  fs.writeFileSync(dataPath, 'fixture-data\n', 'utf-8');
  fs.writeFileSync(lockPath, 'fixture-package==1.0\n', 'utf-8');
  fs.writeFileSync(
    postPath,
    "from pathlib import Path\nPath('post.json').write_text('{\\\"post\\\": true}\\n', encoding='utf-8')\n",
    'utf-8',
  );
  writeJson(manifestPath, {
    schema_version: 1,
    entry_point: { script: 'entry.py', tool: 'python', args: ['data.txt'] },
    steps: [
      {
        id: 'compute',
        tool: 'python',
        script: 'entry.py',
        args: ['data.txt'],
        expected_outputs: ['result.json'],
      },
      {
        id: 'post',
        tool: 'python',
        script: 'post.py',
        expected_outputs: ['post.json'],
        depends_on: ['compute'],
      },
    ],
    environment: { python_version: '3.11', platform: 'any' },
    dependencies: {
      python_packages: ['fixture-package==1.0'],
      data_files: ['data.txt'],
      lock_files: ['requirements.lock'],
    },
  });

  const manager = new StateManager(projectRoot);
  manager.ensureDirs();
  const state = manager.readState();
  state.run_id = runId;
  state.workflow_id = 'computation';
  state.run_status = 'running';
  state.gate_satisfied.A3 = 'A3-0001';
  manager.saveState(state);

  const { io, stdout } = makeIo(projectRoot);
  const code = await runCli([
    'run',
    '--workflow-id', 'computation',
    '--run-id', runId,
    '--run-dir', runDir,
    '--manifest', manifestPath,
  ], io);
  expect(code).toBe(0);
  expect(JSON.parse(stdout.join(''))).toMatchObject({ status: 'completed' });

  const checkerPath = path.join(runDir, 'verification', 'decisive_checker.py');
  fs.mkdirSync(path.dirname(checkerPath), { recursive: true });
  return { checkerPath, dataPath, entryPath, helperPath, lockPath, manifestPath, postPath, projectRoot, runDir, runId };
}

function writeChecker(
  fixture: Awaited<ReturnType<typeof prepareCompletedRun>>,
  params: { assertEnvironmentSanitized?: boolean; ignoreOutputs?: boolean; status?: CheckerStatus; exitStatus?: number; summary?: string } = {},
): void {
  const status = params.status ?? 'pass';
  const exitStatus = params.exitStatus ?? (status === 'pass' ? 0 : status === 'fail' ? 1 : 2);
  const summary = params.summary ?? 'Narrow checker verdict.';
  fs.writeFileSync(fixture.checkerPath, [
    'import argparse, hashlib, json, os',
    'from pathlib import Path',
    'p = argparse.ArgumentParser()',
    "p.add_argument('--nullius-request', required=True)",
    "p.add_argument('--nullius-verdict', required=True)",
    'a = p.parse_args()',
    'request_bytes = Path(a.nullius_request).read_bytes()',
    'request = json.loads(request_bytes)',
    ...(params.ignoreOutputs ? [
      "observations = [{'uri': target['uri'], 'path': target['path'], 'sha256': hashlib.sha256(request_bytes).hexdigest()} for target in request['output_targets']]",
    ] : [
      "observations = [{'uri': target['uri'], 'path': target['path'], 'sha256': hashlib.sha256(Path(target['path']).read_bytes()).hexdigest()} for target in request['output_targets']]",
    ]),
    ...(params.assertEnvironmentSanitized ? [
      "forbidden = sorted({'PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'} & set(os.environ))",
      `emitted_status = 'pass' if not forbidden else 'fail'`,
      `emitted_summary = ${JSON.stringify(summary)} if not forbidden else 'Leaked environment: ' + ','.join(forbidden)`,
    ] : [
      `emitted_status = ${JSON.stringify(status)}`,
      `emitted_summary = ${JSON.stringify(summary)}`,
    ]),
    "verdict = {'schema_version': 1, 'request_sha256': hashlib.sha256(request_bytes).hexdigest(), 'check_kind': request['check_kind'], 'status': emitted_status, 'summary': emitted_summary, 'quantity_id': request['quantity_id'], 'layer_id': request['layer_id'], 'disputed_dimensions': request['disputed_dimensions'], 'consumed_output_observations': observations, 'negative_control_results': [{'control_id': control_id, 'status': 'pass'} for control_id in request['required_negative_control_ids']]}",
    "Path(a.nullius_verdict).write_text(json.dumps(verdict, indent=2) + '\\n', encoding='utf-8')",
    params.assertEnvironmentSanitized
      ? "raise SystemExit(0 if emitted_status == 'pass' else 1)"
      : `raise SystemExit(${exitStatus})`,
    '',
  ].join('\n'), 'utf-8');
}

function evidencePaths(fixture: Awaited<ReturnType<typeof prepareCompletedRun>>): string[] {
  const result = readJson<{ produced_artifact_refs: ArtifactRefV1[] }>(
    path.join(fixture.runDir, 'artifacts', 'computation_result_v1.json'),
  );
  return result.produced_artifact_refs.filter(ref => ref.kind === 'structured_result').map((ref) => {
    const marker = '/artifact/';
    return decodeURIComponent(ref.uri.slice(ref.uri.indexOf(marker) + marker.length));
  });
}

async function record(
  fixture: Awaited<ReturnType<typeof prepareCompletedRun>>,
  params: {
    runtime?: string;
    helperPaths?: string[];
    evidenceOrder?: string[];
    operatorStatus?: 'passed' | 'failed' | 'blocked';
    operatorSummary?: string;
  } = {},
) {
  const manifestRef = artifactRef(fixture.runId, fixture.runDir, fixture.manifestPath, 'reference');
  return handleOrchRunRecordVerification({
    project_root: fixture.projectRoot,
    run_id: fixture.runId,
    status: params.operatorStatus ?? 'passed',
    summary: params.operatorSummary ?? 'Operator description.',
    evidence_paths: params.evidenceOrder ?? evidencePaths(fixture),
    checker_path: fixture.checkerPath,
    checker_runtime: params.runtime ?? 'python3',
    checker_helper_paths: params.helperPaths ?? [],
    quantity_id: 'quantity:fixture-output',
    layer_id: 'layer:production-output',
    reference_provenance: [{ reference_id: 'reference:fixture', uri: manifestRef.uri, sha256: manifestRef.sha256 }],
    disputed_dimensions: ['normalization', 'component-composition'],
    required_negative_control_ids: ['negative-control:zero-input'],
    confidence_level: 'high',
    check_kind: 'decisive_verification',
  } as never);
}

describe('Nullius-owned validation-chain binding at the A5 boundary', () => {
  const runtimeIdentity = (requestedToken: string): NativeRuntimeIdentity => ({
    requested_token: requestedToken,
    canonical_path: '/usr/bin/runtime-fixture',
    sha256: '0'.repeat(64),
    size_bytes: 1,
    executable_format: 'mach_o',
  });

  it('uses a runtime allowlist, rejects shell/module/project selectors and fixed-key overrides, and ignores host BASH_ENV', () => {
    const prior = process.env.BASH_ENV;
    process.env.BASH_ENV = '/tmp/nullius-hostile-bash-env.sh';
    try {
      const clean = buildProductionEnvironment(runtimeIdentity('bash'), { OMP_NUM_THREADS: '1' });
      expect(clean.policy).toBe('nullius_production_allowlist_v1');
      expect(clean.variables).toMatchObject({ OMP_NUM_THREADS: '1' });
      expect(clean.variables.BASH_ENV).toBeUndefined();
      for (const key of ['BASH_ENV', 'ENV', 'NODE_PATH', 'JULIA_PROJECT', 'LANG']) {
        expect(() => buildProductionEnvironment(runtimeIdentity('bash'), { [key]: 'hostile' }))
          .toThrow(/not allowlisted|fixed safety/iu);
      }
    } finally {
      if (prior === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = prior;
    }
  });

  it('runs production with an explicit recorded environment instead of inheriting host loader/module variables', async () => {
    const keys = ['BASH_ENV', 'PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'] as const;
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.BASH_ENV = '/tmp/nullius-hostile-production-bash-env.sh';
    process.env.PYTHONPATH = '/tmp/nullius-hostile-production-module-path';
    process.env.PYTHONHOME = '/tmp/nullius-hostile-production-home';
    process.env.NODE_OPTIONS = '--require=/tmp/nullius-hostile-production-preload.js';
    process.env.LD_PRELOAD = '';
    process.env.DYLD_INSERT_LIBRARIES = '';
    try {
      const fixture = await prepareCompletedRun();
      const status = readJson<Record<string, any>>(path.join(fixture.runDir, 'computation', 'execution_status.json'));
      expect(status.status).toBe('completed');
      expect(status.steps[0].execution_environment.policy).toBe('nullius_production_allowlist_v1');
      expect(Object.keys(status.steps[0].execution_environment.variables)).not.toEqual(expect.arrayContaining(keys as unknown as string[]));
    } finally {
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });

  it('directly hashes every required output and records a narrow decisive verdict', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture, { summary: 'Only the declared output identity passed.' });
    await record(fixture, { operatorSummary: 'All science is final.' });

    const checkRun = readJson<Record<string, unknown>>(
      path.join(fixture.runDir, 'artifacts', 'verification_check_run_computation_result_v1.json'),
    );
    expect(checkRun.summary).toBe('Only the declared output identity passed.');
    expect(checkRun.executor_provenance).toMatchObject({ executor_kind: 'nullius_direct_checker' });
    await expect(handleOrchRunRequestFinalConclusions({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
    })).resolves.toMatchObject({ gate_decision: 'unavailable', requires_approval: false });
  });

  it('canonicalizes a legal evidence-path permutation before executing the checker', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    const canonicalPaths = evidencePaths(fixture);
    expect(canonicalPaths).toHaveLength(2);

    await expect(record(fixture, {
      evidenceOrder: [...canonicalPaths].reverse(),
    })).resolves.toMatchObject({ status: 'passed' });

    const request = readJson<Record<string, any>>(
      path.join(fixture.runDir, 'artifacts', 'validation-chain', 'checker_request_v1.json'),
    );
    expect(request.output_targets.map((target: { path: string }) => target.path)).toEqual(canonicalPaths);
  });

  it('rejects a checker verdict whose self-reported output observations do not match held hashes', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture, { ignoreOutputs: true });
    await expect(record(fixture)).rejects.toThrow(/observation.*production bytes|output observation/i);
  });

  it('rejects an undeclared adjacent Python helper import and binds explicitly declared helper bytes', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    const helperPath = path.join(path.dirname(fixture.checkerPath), 'local_helper.py');
    fs.writeFileSync(helperPath, 'TOKEN = 1\n', 'utf-8');
    fs.writeFileSync(fixture.checkerPath, `from local_helper import TOKEN\n${fs.readFileSync(fixture.checkerPath, 'utf-8')}`, 'utf-8');
    await expect(record(fixture)).rejects.toThrow(/undeclared.*helper/i);

    // A declared imported helper is available under the recorded sanitized
    // Python search path and remains content-bound in request and receipt.
    await expect(record(fixture, { helperPaths: [helperPath] })).resolves.toMatchObject({ status: 'passed' });
    const receipt = readJson<Record<string, any>>(path.join(fixture.runDir, 'artifacts', 'validation_chain_binding_v1.json'));
    expect(receipt.checker_helper_refs).toHaveLength(1);
    expect(receipt.checker_helper_refs[0].sha256).toBe(sha256File(helperPath));
    expect(receipt.checker_environment.variables).toMatchObject({
      PYTHONSAFEPATH: '1',
      PYTHONPATH: path.dirname(fixture.checkerPath),
    });
  });

  it('consumes all check-run refs independent of order while allowing schema-valid supporting checks', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    await record(fixture);
    const resultPath = path.join(fixture.runDir, 'artifacts', 'computation_result_v1.json');
    const result = readJson<Record<string, any>>(resultPath);
    const subjectRef = result.verification_refs.subject_refs[0] as ArtifactRefV1;
    const decisiveRef = result.verification_refs.check_run_refs[0] as ArtifactRefV1;
    const decisive = readJson<Record<string, any>>(
      path.join(fixture.runDir, 'artifacts', 'verification_check_run_computation_result_v1.json'),
    );
    const supportingPath = path.join(fixture.runDir, 'artifacts', 'verification_check_run_supporting_v1.json');
    const timestamp = new Date().toISOString();
    writeJson(supportingPath, {
      schema_version: 1,
      check_run_id: `check:${fixture.runId}:supporting`,
      run_id: fixture.runId,
      subject_id: decisive.subject_id,
      subject_ref: subjectRef,
      check_kind: 'supporting_diagnostic',
      check_role: 'supporting',
      status: 'passed',
      summary: 'Supporting diagnostic completed.',
      evidence_refs: decisive.evidence_refs,
      executor_provenance: { component: 'test-fixture', surface: 'supporting-diagnostic' },
      confidence: { level: 'medium' },
      started_at: timestamp,
      finished_at: timestamp,
    });
    const supportingRef = artifactRef(fixture.runId, fixture.runDir, supportingPath, 'verification_check_run');
    const verdictPath = path.join(fixture.runDir, 'artifacts', 'verification_subject_verdict_computation_result_v1.json');
    const verdict = readJson<Record<string, any>>(verdictPath);
    verdict.check_run_refs = [supportingRef, decisiveRef];
    writeJson(verdictPath, verdict);
    const verdictRef = artifactRef(fixture.runId, fixture.runDir, verdictPath, 'verification_subject_verdict');
    const coveragePath = path.join(fixture.runDir, 'artifacts', 'verification_coverage_v1.json');
    const coverage = readJson<Record<string, any>>(coveragePath);
    coverage.subject_verdict_refs = [verdictRef];
    writeJson(coveragePath, coverage);
    result.verification_refs.check_run_refs = [supportingRef, decisiveRef];
    result.verification_refs.subject_verdict_refs = [verdictRef];
    result.verification_refs.coverage_refs = [artifactRef(fixture.runId, fixture.runDir, coveragePath, 'verification_coverage')];
    writeJson(resultPath, result);
    await expect(handleOrchRunRequestFinalConclusions({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
    })).resolves.toMatchObject({ gate_decision: 'unavailable', requires_approval: false });
  });

  it('rejects a caller-authored pass receipt without executing a checker', async () => {
    const fixture = await prepareCompletedRun();
    const receiptPath = path.join(fixture.runDir, 'artifacts', 'handwritten.json');
    writeJson(receiptPath, { structured_verdict: { status: 'pass', summary: 'handwritten' } });
    await expect(handleOrchRunRecordVerification({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
      status: 'passed',
      summary: 'handwritten',
      evidence_paths: evidencePaths(fixture),
      validation_chain_receipt_path: receiptPath,
      confidence_level: 'high',
      check_kind: 'decisive_verification',
    } as never)).rejects.toThrow(/caller-authored|checker_path/i);
  });

  it('rejects an actual nonzero checker exit that emits pass', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture, { status: 'pass', exitStatus: 7 });
    await expect(record(fixture)).rejects.toThrow(/exit status conflicts/i);
  });

  it.each([
    ['fail', 'failed'],
    ['blocked', 'blocked'],
  ] as const)('rejects checker verdict %s when the process exits zero', async (checkerStatus, operatorStatus) => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture, { status: checkerStatus, exitStatus: 0 });
    await expect(record(fixture, { operatorStatus })).rejects.toThrow(/exit status conflicts/i);
  });

  it('rejects operator pass when the checker verdict is fail', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture, { status: 'fail', exitStatus: 1 });
    await expect(record(fixture, { operatorStatus: 'passed' })).rejects.toThrow(/cannot replace or upgrade/i);
  });

  it('does not inherit preload, module-path, or runtime-option variables into the checker', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture, { assertEnvironmentSanitized: true, summary: 'Checker environment was sanitized.' });
    const keys = ['PYTHONPATH', 'PYTHONHOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'] as const;
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.PYTHONPATH = '/tmp/nullius-hostile-module-path';
    process.env.PYTHONHOME = '/tmp/nullius-hostile-python-home';
    process.env.NODE_OPTIONS = '--require=/tmp/nullius-hostile-node-preload.js';
    // Empty preload values remain observable in os.environ if inherited but
    // do not break unrelated sqlite subprocesses executed after the checker.
    process.env.LD_PRELOAD = '';
    process.env.DYLD_INSERT_LIBRARIES = '';
    try {
      await expect(record(fixture)).resolves.toMatchObject({ status: 'passed' });
      const receipt = readJson<Record<string, any>>(
        path.join(fixture.runDir, 'artifacts', 'validation_chain_binding_v1.json'),
      );
      expect(Object.keys(receipt.checker_environment.variables)).not.toEqual(
        expect.arrayContaining(keys as unknown as string[]),
      );
    } finally {
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });

  it.each([
    ['shell', 'bash'],
    ['runtime path', '/usr/bin/python3'],
    ['runtime flags', 'python3 -c'],
  ])('rejects %s in the checker runtime token', async (_name, runtime) => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    await expect(record(fixture, { runtime })).rejects.toThrow(/allowlisted|bare/i);
  });

  it('skips a PATH-prepended script masquerading as python3 and executes canonical native bytes', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-fake-runtime-'));
    const fakeRuntime = path.join(fakeDir, 'python3');
    fs.writeFileSync(fakeRuntime, '#!/bin/sh\nexit 99\n', 'utf-8');
    fs.chmodSync(fakeRuntime, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeDir}${path.delimiter}${oldPath ?? ''}`;
    try {
      await expect(record(fixture)).resolves.toMatchObject({ status: 'passed' });
      const receipt = readJson<Record<string, any>>(
        path.join(fixture.runDir, 'artifacts', 'validation_chain_binding_v1.json'),
      );
      expect(receipt.checker_runtime.canonical_path).not.toBe(fakeRuntime);
      expect(receipt.checker_runtime.executable_format).toMatch(/^(?:elf|mach_o|pe)$/u);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('fails closed when the production entry changes after verification', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    await record(fixture);
    fs.appendFileSync(fixture.entryPath, '# tampered\n', 'utf-8');
    await expect(handleOrchRunRequestFinalConclusions({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
    })).resolves.toMatchObject({ gate_decision: 'unavailable', ready_for_final_conclusions: false });
  });

  it('fails closed when the decisive checker changes after verification', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    await record(fixture);
    fs.appendFileSync(fixture.checkerPath, '# tampered\n', 'utf-8');
    await expect(handleOrchRunRequestFinalConclusions({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
    })).resolves.toMatchObject({ gate_decision: 'unavailable', ready_for_final_conclusions: false });
  });

  it('fails closed when any non-entry production step changes after verification', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    await record(fixture);
    fs.appendFileSync(fixture.postPath, '# changed non-entry step\n', 'utf-8');
    await expect(handleOrchRunRequestFinalConclusions({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
    })).resolves.toMatchObject({ gate_decision: 'unavailable', ready_for_final_conclusions: false });
  });

  it('fails closed when an imported implementation file changes after verification', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    await record(fixture);
    fs.appendFileSync(fixture.helperPath, 'VALUE = 2\n', 'utf-8');
    await expect(handleOrchRunRequestFinalConclusions({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
    })).resolves.toMatchObject({ gate_decision: 'unavailable', ready_for_final_conclusions: false });
  });

  it('fails closed when a declared data input changes after verification', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    await record(fixture);
    fs.appendFileSync(fixture.dataPath, 'tampered\n', 'utf-8');
    await expect(handleOrchRunRequestFinalConclusions({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
    })).resolves.toMatchObject({ gate_decision: 'unavailable', ready_for_final_conclusions: false });
  });

  it('re-gates an already-pending A5 request instead of returning a hard-coded pass', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    await record(fixture);
    await handleOrchRunRequestFinalConclusions({ project_root: fixture.projectRoot, run_id: fixture.runId });
    fs.appendFileSync(fixture.checkerPath, '# stale pending approval\n', 'utf-8');
    await expect(handleOrchRunRequestFinalConclusions({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
    })).resolves.toMatchObject({ gate_decision: 'unavailable', requires_approval: false });
  });

  it('treats a legacy decisive check run without binding as unavailable at A5', async () => {
    const fixture = await prepareCompletedRun();
    writeChecker(fixture);
    await record(fixture);
    const checkRunPath = path.join(fixture.runDir, 'artifacts', 'verification_check_run_computation_result_v1.json');
    const checkRun = readJson<Record<string, unknown>>(checkRunPath);
    delete checkRun.validation_chain_binding_ref;
    writeJson(checkRunPath, checkRun);
    const checkRunRef = artifactRef(fixture.runId, fixture.runDir, checkRunPath, 'verification_check_run');
    const subjectVerdictPath = path.join(fixture.runDir, 'artifacts', 'verification_subject_verdict_computation_result_v1.json');
    const subjectVerdict = readJson<Record<string, unknown>>(subjectVerdictPath);
    subjectVerdict.check_run_refs = [checkRunRef];
    writeJson(subjectVerdictPath, subjectVerdict);
    const resultPath = path.join(fixture.runDir, 'artifacts', 'computation_result_v1.json');
    const result = readJson<Record<string, any>>(resultPath);
    result.verification_refs.check_run_refs = [checkRunRef];
    result.verification_refs.subject_verdict_refs = [artifactRef(fixture.runId, fixture.runDir, subjectVerdictPath, 'verification_subject_verdict')];
    writeJson(resultPath, result);
    await expect(handleOrchRunRequestFinalConclusions({
      project_root: fixture.projectRoot,
      run_id: fixture.runId,
    })).resolves.toMatchObject({ gate_decision: 'unavailable', ready_for_final_conclusions: false });
  });

  it('rejects a dummy entry point that is not exactly one actual step', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-dummy-entry-'));
    const runId = 'dummy-entry';
    const runDir = path.join(projectRoot, runId);
    const computationDir = path.join(runDir, 'computation');
    fs.mkdirSync(computationDir, { recursive: true });
    fs.writeFileSync(path.join(computationDir, 'dummy.py'), 'raise SystemExit(0)\n');
    fs.writeFileSync(path.join(computationDir, 'real.py'), "from pathlib import Path\nPath('out.json').write_text('{}\\n')\n");
    const manifestPath = path.join(computationDir, 'manifest.json');
    writeJson(manifestPath, {
      schema_version: 1,
      entry_point: { script: 'dummy.py', tool: 'python' },
      steps: [{ id: 'real', tool: 'python', script: 'real.py', expected_outputs: ['out.json'] }],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = runId;
    state.workflow_id = 'computation';
    state.run_status = 'running';
    state.gate_satisfied.A3 = 'A3-0001';
    manager.saveState(state);
    const io = makeIo(projectRoot);
    await expect(runCli(['run', '--workflow-id', 'computation', '--run-id', runId, '--run-dir', runDir, '--manifest', manifestPath], io.io))
      .rejects.toThrow(/exactly one executed manifest step/i);
    expect(fs.existsSync(path.join(computationDir, 'out.json'))).toBe(false);
  });

  it('detects step 1 rewriting step 2 before step 2 is spawned', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-step-rewrite-'));
    const runId = 'step-rewrite';
    const runDir = path.join(projectRoot, runId);
    const computationDir = path.join(runDir, 'computation');
    fs.mkdirSync(computationDir, { recursive: true });
    fs.writeFileSync(path.join(computationDir, 'step1.py'), "from pathlib import Path\nPath('one.json').write_text('{}\\n')\nPath('step2.py').write_text('# changed\\n')\n");
    fs.writeFileSync(path.join(computationDir, 'step2.py'), "from pathlib import Path\nPath('two.json').write_text('{}\\n')\n");
    const manifestPath = path.join(computationDir, 'manifest.json');
    writeJson(manifestPath, {
      schema_version: 1,
      entry_point: { script: 'step1.py', tool: 'python' },
      steps: [
        { id: 'one', tool: 'python', script: 'step1.py', expected_outputs: ['one.json'] },
        { id: 'two', tool: 'python', script: 'step2.py', expected_outputs: ['two.json'], depends_on: ['one'] },
      ],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = runId;
    state.workflow_id = 'computation';
    state.run_status = 'running';
    state.gate_satisfied.A3 = 'A3-0001';
    manager.saveState(state);
    const io = makeIo(projectRoot);
    await runCli(['run', '--workflow-id', 'computation', '--run-id', runId, '--run-dir', runDir, '--manifest', manifestPath], io.io);
    expect(fs.existsSync(path.join(computationDir, 'two.json'))).toBe(false);
    const executionStatus = readJson<Record<string, any>>(path.join(computationDir, 'execution_status.json'));
    expect(executionStatus.status).toBe('failed');
    expect(executionStatus.errors.join('\n')).toMatch(/pre-spawn inputs after exit.*changed|step 'two'.*changed/i);
  });

  it('fails execution when a later step overwrites an earlier declared output', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-output-overwrite-'));
    const runId = 'output-overwrite';
    const runDir = path.join(projectRoot, runId);
    const computationDir = path.join(runDir, 'computation');
    fs.mkdirSync(computationDir, { recursive: true });
    fs.writeFileSync(path.join(computationDir, 'step1.py'), "from pathlib import Path\nPath('one.json').write_text('one\\n')\n");
    fs.writeFileSync(path.join(computationDir, 'step2.py'), "from pathlib import Path\nPath('one.json').write_text('changed\\n')\nPath('two.json').write_text('two\\n')\n");
    const manifestPath = path.join(computationDir, 'manifest.json');
    writeJson(manifestPath, {
      schema_version: 1,
      entry_point: { script: 'step1.py', tool: 'python' },
      steps: [
        { id: 'one', tool: 'python', script: 'step1.py', expected_outputs: ['one.json'] },
        { id: 'two', tool: 'python', script: 'step2.py', expected_outputs: ['two.json'], depends_on: ['one'] },
      ],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {},
    });
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = runId;
    state.workflow_id = 'computation';
    state.run_status = 'running';
    state.gate_satisfied.A3 = 'A3-0001';
    manager.saveState(state);
    const io = makeIo(projectRoot);
    await runCli(['run', '--workflow-id', 'computation', '--run-id', runId, '--run-dir', runDir, '--manifest', manifestPath], io.io);
    const executionStatus = readJson<Record<string, any>>(path.join(computationDir, 'execution_status.json'));
    expect(executionStatus.status).toBe('failed');
    expect(executionStatus.errors.join('\n')).toMatch(/prior step output.*changed|pre-spawn inputs after exit.*changed/i);
  });

  it('rejects relative external dependency refs before execution instead of resolving them against process cwd', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-relative-external-ref-'));
    const runId = 'relative-external-ref';
    const runDir = path.join(projectRoot, runId);
    const computationDir = path.join(runDir, 'computation');
    fs.mkdirSync(computationDir, { recursive: true });
    fs.writeFileSync(path.join(computationDir, 'entry.py'), "raise SystemExit(0)\n", 'utf-8');
    const manifestPath = path.join(computationDir, 'manifest.json');
    writeJson(manifestPath, {
      schema_version: 1,
      entry_point: { script: 'entry.py', tool: 'python' },
      steps: [{ id: 'compute', tool: 'python', script: 'entry.py' }],
      environment: { python_version: '3.11', platform: 'any' },
      dependencies: {
        external_dependency_refs: [{ path: '../outside.dat', sha256: '0'.repeat(64) }],
      },
    });
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = runId;
    state.workflow_id = 'computation';
    state.run_status = 'running';
    state.gate_satisfied.A3 = 'A3-0001';
    manager.saveState(state);
    await expect(runCli([
      'run', '--workflow-id', 'computation', '--run-id', runId, '--run-dir', runDir, '--manifest', manifestPath,
    ], makeIo(projectRoot).io)).rejects.toThrow(/external_dependency_refs.*absolute/iu);
  });
});
