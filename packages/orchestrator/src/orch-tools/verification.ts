import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  ArtifactRefV1,
  ValidationChainBindingV1,
  ValidationCheckerRequestV1,
  ValidationCheckerVerdictV1,
  VerificationCoverageV1,
  VerificationSubjectV1,
  VerificationSubjectVerdictV1,
} from '@nullius/shared';
import { invalidParams, writeBytesAtomicDurable } from '@nullius/shared';
import { z } from 'zod';
import { createRunArtifactRef } from '../computation/artifact-refs.js';
import { writeJsonAtomic } from '../computation/io.js';
import { assertNoSymlinkComponents } from '../computation/path-safety.js';
import { assertNativeRuntimeIdentityLive } from '../computation/runtime-identity.js';
import { recordVerificationToMemoryGraph } from '../computation/memory-graph-hookup.js';
import { attachVerificationBoundaryToWorkspaceFeedback } from '../computation/workspace-feedback-boundaries.js';
import { assertComputationResultValid } from '../computation/result-schema.js';
import { createStateManager, requireState } from './common.js';
import { OrchRunRecordVerificationSchema } from './schemas.js';
import {
  assertCheckerObservedRequiredSurface,
  assertValidationCheckerVerdictValid,
  buildLiveProductionBinding,
  prepareDirectCheckerExecution,
  type BoundVerificationCheckRunV1,
  sha256Bytes,
  validateValidationChainBinding,
} from './validation-chain-binding.js';

type VerificationStatus = z.output<typeof OrchRunRecordVerificationSchema>['status'];

function resolveWithinRunDir(runDir: string, candidatePath: string, field: string): string {
  const resolvedRunDir = path.resolve(runDir);
  const resolved = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(resolvedRunDir, candidatePath);
  const relative = path.relative(resolvedRunDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidParams(`${field} must stay within the run directory`, {
      field,
      run_dir: resolvedRunDir,
      candidate: candidatePath,
    });
  }
  assertNoSymlinkComponents(resolvedRunDir, resolved, field, { allowMissingLeaf: true });
  if (fs.existsSync(resolved)) {
    const canonicalRunDir = fs.realpathSync.native(resolvedRunDir);
    const canonicalPath = fs.realpathSync.native(resolved);
    const canonicalRelative = path.relative(canonicalRunDir, canonicalPath);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      throw invalidParams(`${field} resolves outside the run directory`, {
        field,
        canonical_path: canonicalPath,
      });
    }
  }
  return resolved;
}

function loadRequiredJson<T>(filePath: string, label: string): T {
  if (!fs.existsSync(filePath)) {
    throw invalidParams(`${label} is required before recording decisive verification.`, {
      missing_path: filePath,
      next_actions: [{
        tool: 'orch_run_execute_manifest',
        reason: 'Generate the canonical computation_result_v1 and verification kernel seed artifacts before recording decisive verification.',
      }],
    });
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function updateCoverageSummary(status: VerificationStatus): VerificationCoverageV1['summary'] {
  return {
    subjects_total: 1,
    subjects_verified: status === 'passed' ? 1 : 0,
    subjects_partial: 0,
    subjects_failed: status === 'failed' ? 1 : 0,
    subjects_blocked: status === 'blocked' ? 1 : 0,
    subjects_not_attempted: 0,
  };
}

function verdictStatus(status: VerificationStatus): VerificationSubjectVerdictV1['status'] {
  if (status === 'passed') return 'verified';
  if (status === 'failed') return 'failed';
  return 'blocked';
}

function checkerStatus(status: ValidationCheckerVerdictV1['status']): VerificationStatus {
  if (status === 'pass') return 'passed';
  if (status === 'fail') return 'failed';
  return 'blocked';
}

function readCheckerVerdict(filePath: string): ValidationCheckerVerdictV1 {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw invalidParams('Directly executed checker did not produce its required structured verdict JSON.', {
      verdict_path: filePath,
    });
  }
  try {
    return assertValidationCheckerVerdictValid(JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown);
  } catch (error) {
    throw invalidParams('Directly executed checker produced an invalid structured verdict JSON.', {
      verdict_path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function requireSemanticContract(
  params: z.output<typeof OrchRunRecordVerificationSchema>,
): Pick<
  ValidationCheckerRequestV1,
  | 'quantity_id'
  | 'layer_id'
  | 'reference_provenance'
  | 'disputed_dimensions'
  | 'required_negative_control_ids'
> {
  if (!params.quantity_id || !params.layer_id || !params.reference_provenance?.length
    || !params.disputed_dimensions?.length || !params.required_negative_control_ids?.length) {
    throw invalidParams('Decisive verification requires an explicit non-empty semantic surface.', {
      required: ['quantity_id', 'layer_id', 'reference_provenance', 'disputed_dimensions', 'required_negative_control_ids'],
    });
  }
  return {
    quantity_id: params.quantity_id,
    layer_id: params.layer_id,
    reference_provenance: params.reference_provenance as ValidationCheckerRequestV1['reference_provenance'],
    disputed_dimensions: [...new Set(params.disputed_dimensions)] as ValidationCheckerRequestV1['disputed_dimensions'],
    required_negative_control_ids: [...new Set(params.required_negative_control_ids)] as ValidationCheckerRequestV1['required_negative_control_ids'],
  };
}

function bindCheckerHelpers(params: {
  checkerPath: string;
  declaredPaths: string[];
  runDir: string;
  runId: string;
}): ArtifactRefV1[] {
  const source = fs.readFileSync(params.checkerPath, 'utf-8');
  const checkerDir = path.dirname(params.checkerPath);
  const detected = new Set<string>();
  const addIfFile = (candidate: string) => {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) detected.add(fs.realpathSync.native(candidate));
  };
  if (/\.py$/u.test(params.checkerPath)) {
    const addPythonModule = (specifier: string) => {
      const leadingDots = specifier.match(/^\.+/u)?.[0].length ?? 0;
      let moduleRoot = checkerDir;
      for (let level = 1; level < leadingDots; level += 1) moduleRoot = path.dirname(moduleRoot);
      const components = specifier.slice(leadingDots).split('.').filter(Boolean);
      for (let index = 1; index <= components.length; index += 1) {
        addIfFile(path.join(moduleRoot, ...components.slice(0, index), '__init__.py'));
      }
      if (components.length > 0) {
        const moduleBase = path.join(moduleRoot, ...components);
        addIfFile(`${moduleBase}.py`);
        addIfFile(path.join(moduleBase, '__init__.py'));
      } else if (leadingDots > 0) {
        addIfFile(path.join(moduleRoot, '__init__.py'));
      }
      return { components, moduleRoot };
    };
    for (const match of source.matchAll(/^\s*import\s+([^#\n]+)/gmu)) {
      for (const clause of match[1]!.split(',')) {
        const specifier = clause.trim().split(/\s+/u)[0]!;
        if (/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(specifier)) addPythonModule(specifier);
      }
    }
    for (const match of source.matchAll(/^\s*from\s+([.A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([^#\n]+)/gmu)) {
      const base = addPythonModule(match[1]!);
      for (const clause of match[2]!.replace(/[()]/gu, '').split(',')) {
        const imported = clause.trim().split(/\s+/u)[0]!;
        if (imported !== '*' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(imported)) {
          const candidateBase = path.join(base.moduleRoot, ...base.components, imported);
          addIfFile(`${candidateBase}.py`);
          addIfFile(path.join(candidateBase, '__init__.py'));
        }
      }
    }
  } else if (/\.(?:cjs|mjs|js)$/u.test(params.checkerPath)) {
    for (const match of source.matchAll(/(?:require\s*\(\s*|from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/gu)) {
      const base = path.resolve(checkerDir, match[1]!);
      for (const candidate of [
        base,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}.json`,
        path.join(base, 'index.js'),
        path.join(base, 'index.mjs'),
        path.join(base, 'index.cjs'),
        path.join(base, 'index.json'),
      ]) addIfFile(candidate);
    }
  }
  const declared = params.declaredPaths.map(helperPath => {
    const resolved = resolveWithinRunDir(params.runDir, helperPath, 'checker_helper_paths');
    if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isFile()) {
      throw invalidParams('Each checker helper must be an existing regular file inside the run dir.', { helper_path: helperPath });
    }
    return { resolved, canonical: fs.realpathSync.native(resolved) };
  });
  const declaredSet = new Set(declared.map(item => item.canonical));
  const missing = [...detected].filter(filePath => !declaredSet.has(filePath));
  if (missing.length > 0) {
    throw invalidParams('Checker has undeclared relative/local helper imports.', { missing_helper_paths: missing });
  }
  return [...new Map(declared.map(item => [item.canonical, item.resolved])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, resolved]) =>
      createRunArtifactRef(params.runId, params.runDir, resolved, 'decisive_checker_helper'));
}

export async function handleOrchRunRecordVerification(
  params: z.output<typeof OrchRunRecordVerificationSchema>,
): Promise<unknown> {
  if (params.validation_chain_receipt_path) {
    throw invalidParams('Caller-authored validation-chain receipts are unavailable for decisive verification. Supply checker_path and checker_runtime; Nullius will execute the checker and create the receipt.', {
      migration: 'Replace validation_chain_receipt_path with checker_path plus a bare checker_runtime token.',
    });
  }
  if (params.checker_command) {
    throw invalidParams('Caller-authored checker commands are unavailable for decisive verification.', {
      migration: 'Replace checker_command with checker_runtime="python3" or checker_runtime="node".',
    });
  }
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  if (state.run_id !== params.run_id) {
    throw invalidParams('Current orchestrator state does not match the requested run_id.', {
      state_run_id: state.run_id,
      requested_run_id: params.run_id,
    });
  }

  const runDir = path.join(projectRoot, params.run_id);
  const computationResultPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
  const subjectPath = path.join(runDir, 'artifacts', 'verification_subject_computation_result_v1.json');
  const subjectVerdictPath = path.join(runDir, 'artifacts', 'verification_subject_verdict_computation_result_v1.json');
  const coveragePath = path.join(runDir, 'artifacts', 'verification_coverage_v1.json');
  const checkRunPath = path.join(runDir, 'artifacts', 'verification_check_run_computation_result_v1.json');
  const chainDir = path.join(runDir, 'artifacts', 'validation-chain');
  const requestPath = path.join(chainDir, 'checker_request_v1.json');
  const checkerVerdictPath = path.join(chainDir, 'checker_verdict_v1.json');
  const checkerStdoutPath = path.join(chainDir, 'checker_stdout.txt');
  const checkerStderrPath = path.join(chainDir, 'checker_stderr.txt');
  const receiptPath = path.join(runDir, 'artifacts', 'validation_chain_binding_v1.json');
  fs.mkdirSync(chainDir, { recursive: true });

  const computationResult = assertComputationResultValid(loadRequiredJson<unknown>(computationResultPath, 'computation_result_v1.json'));
  const subject = loadRequiredJson<VerificationSubjectV1>(subjectPath, 'verification_subject_computation_result_v1.json');
  const subjectVerdict = loadRequiredJson<VerificationSubjectVerdictV1>(subjectVerdictPath, 'verification_subject_verdict_computation_result_v1.json');
  const coverage = loadRequiredJson<VerificationCoverageV1>(coveragePath, 'verification_coverage_v1.json');
  if (
    computationResult.run_id !== params.run_id
    || subject.run_id !== params.run_id
    || subjectVerdict.run_id !== params.run_id
    || coverage.run_id !== params.run_id
    || subjectVerdict.subject_id !== subject.subject_id
  ) {
    throw invalidParams('Verification artifacts do not match the requested run provenance.', { run_id: params.run_id });
  }

  const liveProduction = buildLiveProductionBinding({
    computationResult,
    projectRoot,
    runDir,
    runId: params.run_id,
  });
  const semanticContract = requireSemanticContract(params);
  const evidenceRefs: ArtifactRefV1[] = params.evidence_paths.map((evidencePath) => {
    const resolved = resolveWithinRunDir(runDir, evidencePath, 'evidence_paths');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw invalidParams('Each evidence path must resolve to an existing file inside the run dir.', {
        evidence_path: evidencePath,
        resolved_path: resolved,
      });
    }
    return createRunArtifactRef(params.run_id, runDir, resolved, 'verification_evidence');
  });
  const refKey = (ref: ArtifactRefV1) => `${ref.uri}\n${ref.sha256}`;
  if (
    evidenceRefs.length !== liveProduction.input_refs.length
    || evidenceRefs.map(refKey).sort().some((key, index) => key !== liveProduction.input_refs.map(refKey).sort()[index])
  ) {
    throw invalidParams('evidence_paths must exactly name every structured output of every actual production step.', {});
  }
  const evidenceByKey = new Map(
    evidenceRefs.map((ref, index) => [refKey(ref), params.evidence_paths[index]!] as const),
  );
  if (evidenceByKey.size !== evidenceRefs.length) {
    throw invalidParams('evidence_paths must not repeat a structured production output.', {});
  }
  const canonicalEvidence = liveProduction.input_refs.map(ref => {
    const evidencePath = evidenceByKey.get(refKey(ref));
    if (!evidencePath) {
      throw invalidParams('evidence_paths could not be projected into canonical production-output order.', {
        output_uri: ref.uri,
      });
    }
    return {
      ref,
      path: path.relative(
        runDir,
        resolveWithinRunDir(runDir, evidencePath, 'evidence_paths'),
      ).split(path.sep).join('/'),
    };
  });

  const checkerPath = resolveWithinRunDir(runDir, params.checker_path, 'checker_path');
  if (!fs.existsSync(checkerPath) || !fs.statSync(checkerPath).isFile()) {
    throw invalidParams('checker_path must resolve to an existing regular file inside the run dir.', {
      checker_path: params.checker_path,
    });
  }
  const checkerRef = createRunArtifactRef(params.run_id, runDir, checkerPath, 'decisive_checker');
  const checkerHelperRefs = bindCheckerHelpers({
    checkerPath,
    declaredPaths: params.checker_helper_paths ?? [],
    runDir,
    runId: params.run_id,
  });
  const checkKind = params.check_kind ?? 'decisive_verification';
  const checkerExecution = prepareDirectCheckerExecution({
    checkerRuntimeToken: params.checker_runtime,
    checkerPath,
    projectRoot,
    requestPath,
    runDir,
    verdictPath: checkerVerdictPath,
    pythonHelperSearchPath: checkerHelperRefs.length > 0 ? path.dirname(checkerPath) : undefined,
  });
  const request: ValidationCheckerRequestV1 = {
    schema_version: 1,
    run_id: params.run_id,
    subject_id: subject.subject_id,
    check_kind: checkKind,
    ...semanticContract,
    output_targets: canonicalEvidence.map(({ ref, path: targetPath }) => ({
      uri: ref.uri,
      path: targetPath,
    })) as ValidationCheckerRequestV1['output_targets'],
    checker_ref: checkerRef,
    checker_helper_refs: checkerHelperRefs,
    checker_runtime: checkerExecution.runtime,
    checker_environment: checkerExecution.environment,
  };
  writeJsonAtomic(requestPath, request);
  if (fs.existsSync(checkerVerdictPath)) fs.unlinkSync(checkerVerdictPath);
  const command = checkerExecution.command;
  const checkerHashImmediatelyBefore = sha256Bytes(fs.readFileSync(checkerPath));
  if (checkerHashImmediatelyBefore !== checkerRef.sha256) {
    throw invalidParams('checker changed after its request was written and before spawn.', {});
  }
  const startedAt = new Date().toISOString();
  const execution = spawnSync(command[0]!, command.slice(1), {
    cwd: runDir,
    encoding: 'utf-8',
    env: checkerExecution.environment.variables,
    timeout: 30 * 60_000,
    shell: false,
  });
  const finishedAt = new Date().toISOString();
  writeBytesAtomicDurable(checkerStdoutPath, execution.stdout ?? '');
  writeBytesAtomicDurable(checkerStderrPath, execution.stderr ?? '');
  if (sha256Bytes(fs.readFileSync(checkerPath)) !== checkerHashImmediatelyBefore) {
    throw invalidParams('checker changed while it was executing.', {});
  }
  for (const helperRef of checkerHelperRefs) {
    const helperPath = resolveWithinRunDir(runDir, decodeURIComponent(helperRef.uri.slice(helperRef.uri.indexOf('/artifact/') + 10)), 'checker helper');
    if (sha256Bytes(fs.readFileSync(helperPath)) !== helperRef.sha256) {
      throw invalidParams('Checker helper changed while checker was executing.', { uri: helperRef.uri });
    }
  }
  assertNativeRuntimeIdentityLive({
    identity: checkerExecution.runtime,
    projectRoot,
    runDir,
  });
  if (execution.error || execution.status === null) {
    throw invalidParams('Nullius could not complete the decisive checker process.', {
      error: execution.error?.message ?? null,
      signal: execution.signal,
    });
  }

  const emittedVerdict = readCheckerVerdict(checkerVerdictPath);
  const requestBytes = fs.readFileSync(requestPath);
  if (emittedVerdict.request_sha256 !== sha256Bytes(requestBytes)) {
    throw invalidParams('Checker verdict does not bind the exact Nullius-generated request hash.', {});
  }
  if (emittedVerdict.check_kind !== checkKind) {
    throw invalidParams('Operator check_kind cannot replace the checker-emitted check_kind.', {
      expected_check_kind: checkKind,
      emitted_check_kind: emittedVerdict.check_kind,
    });
  }
  assertCheckerObservedRequiredSurface({
    expectedOutputRefs: liveProduction.input_refs,
    request,
    verdict: emittedVerdict,
  });
  const canonicalStatus = checkerStatus(emittedVerdict.status);
  if (params.status !== canonicalStatus) {
    throw invalidParams('Operator status cannot replace or upgrade the directly executed checker verdict.', {
      operator_status: params.status,
      checker_status: canonicalStatus,
    });
  }
  if (emittedVerdict.status === 'pass' ? execution.status !== 0 : execution.status === 0) {
    throw invalidParams('Checker process exit status conflicts with its structured verdict.', {
      exit_status: execution.status,
      checker_status: emittedVerdict.status,
    });
  }

  const requestRef = createRunArtifactRef(params.run_id, runDir, requestPath, 'validation_checker_request');
  const emittedVerdictRef = createRunArtifactRef(params.run_id, runDir, checkerVerdictPath, 'validation_checker_verdict');
  const checkerStdoutRef = createRunArtifactRef(params.run_id, runDir, checkerStdoutPath, 'validation_checker_stdout');
  const checkerStderrRef = createRunArtifactRef(params.run_id, runDir, checkerStderrPath, 'validation_checker_stderr');
  const receipt: ValidationChainBindingV1 = {
    schema_version: 1,
    run_id: params.run_id,
    subject_id: subject.subject_id,
    ...liveProduction,
    ...semanticContract,
    checker_ref: checkerRef,
    checker_helper_refs: checkerHelperRefs,
    checker_runtime: checkerExecution.runtime,
    checker_environment: checkerExecution.environment,
    dependency_closure_status: 'incomplete_declared_and_locked_not_syscall_traced',
    checker_request_ref: requestRef,
    structured_verdict_ref: emittedVerdictRef,
    execution: {
      command: command as ValidationChainBindingV1['execution']['command'],
      exit_status: execution.status,
      stdout_ref: checkerStdoutRef,
      stderr_ref: checkerStderrRef,
      started_at: startedAt,
      finished_at: finishedAt,
    },
  };
  writeJsonAtomic(receiptPath, receipt);

  const subjectRef = createRunArtifactRef(params.run_id, runDir, subjectPath, 'verification_subject');
  const receiptRef = createRunArtifactRef(params.run_id, runDir, receiptPath, 'validation_chain_binding');
  const operatorNote = params.summary === emittedVerdict.summary
    ? params.notes
    : [params.notes, `Operator note (non-authoritative): ${params.summary}`].filter(Boolean).join('\n');
  const checkRun: BoundVerificationCheckRunV1 = {
    schema_version: 1,
    check_run_id: `check:${params.run_id}:computation_result:${emittedVerdict.check_kind}`,
    run_id: params.run_id,
    subject_id: subject.subject_id,
    subject_ref: subjectRef,
    check_kind: emittedVerdict.check_kind,
    check_role: 'decisive',
    status: canonicalStatus,
    summary: emittedVerdict.summary,
    input_artifact_refs: liveProduction.input_refs,
    output_artifact_refs: [requestRef, emittedVerdictRef, checkerStdoutRef, checkerStderrRef],
    evidence_refs: liveProduction.input_refs as [ArtifactRefV1, ...ArtifactRefV1[]],
    executor_provenance: {
      component: '@nullius/orchestrator',
      surface: 'orch_run_record_verification',
      executor_kind: 'nullius_direct_checker',
    },
    validation_chain_binding_ref: receiptRef,
    confidence: {
      level: params.confidence_level,
      ...(params.confidence_score !== undefined ? { score: params.confidence_score } : {}),
    },
    ...(operatorNote ? { notes: operatorNote } : {}),
    started_at: startedAt,
    finished_at: finishedAt,
  };
  validateValidationChainBinding({
    bindingRef: receiptRef,
    checkRun,
    computationResult,
    expectedSubjectId: subject.subject_id,
    projectRoot,
    runDir,
    runId: params.run_id,
  });
  writeJsonAtomic(checkRunPath, checkRun);
  const checkRunRef = createRunArtifactRef(params.run_id, runDir, checkRunPath, 'verification_check_run');

  const nextSubjectVerdict: VerificationSubjectVerdictV1 = {
    ...subjectVerdict,
    status: verdictStatus(canonicalStatus),
    summary: emittedVerdict.summary,
    check_run_refs: [checkRunRef],
    missing_decisive_checks: [],
  };
  writeJsonAtomic(subjectVerdictPath, nextSubjectVerdict);
  const subjectVerdictRef = createRunArtifactRef(params.run_id, runDir, subjectVerdictPath, 'verification_subject_verdict');

  const nextCoverage: VerificationCoverageV1 = {
    ...coverage,
    generated_at: new Date().toISOString(),
    subject_refs: [subjectRef],
    subject_verdict_refs: [subjectVerdictRef],
    summary: updateCoverageSummary(canonicalStatus),
    missing_decisive_checks: [],
  };
  writeJsonAtomic(coveragePath, nextCoverage);
  const coverageRef = createRunArtifactRef(params.run_id, runDir, coveragePath, 'verification_coverage');

  const nextComputationResult = attachVerificationBoundaryToWorkspaceFeedback({
    ...computationResult,
    verification_refs: {
      ...(computationResult.verification_refs ?? {}),
      subject_refs: [subjectRef],
      check_run_refs: [checkRunRef],
      subject_verdict_refs: [subjectVerdictRef],
      coverage_refs: [coverageRef],
    },
  }, {
    status: canonicalStatus,
    summary: emittedVerdict.summary,
    check_run_uri: checkRunRef.uri,
    verdict_uri: subjectVerdictRef.uri,
    coverage_uri: coverageRef.uri,
  });
  writeJsonAtomic(computationResultPath, assertComputationResultValid(nextComputationResult));
  await recordVerificationToMemoryGraph({
    projectRoot,
    runId: params.run_id,
    status: canonicalStatus,
    summary: emittedVerdict.summary,
    checkRunUri: checkRunRef.uri,
  });

  return {
    recorded: true,
    run_id: params.run_id,
    status: canonicalStatus,
    gate_summary: emittedVerdict.summary,
    check_run_uri: checkRunRef.uri,
    verdict_uri: subjectVerdictRef.uri,
    coverage_uri: coverageRef.uri,
    validation_chain_binding_uri: receiptRef.uri,
    computation_result_uri: createRunArtifactRef(params.run_id, runDir, computationResultPath, 'computation_result').uri,
  };
}
