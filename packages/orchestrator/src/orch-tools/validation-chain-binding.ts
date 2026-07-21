import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  ArtifactRefV1,
  ComputationManifestV1,
  ComputationResultV1,
  DecisiveVerificationCheckRun,
  ProductionStepBinding,
  SanitizedCheckerEnvironmentV1,
  ValidationChainBindingV1,
  ValidationCheckerRequestV1,
  ValidationCheckerVerdictV1,
  VerificationCheckRunV1,
} from '@nullius/shared';
import { invalidParams, parseScopedArtifactUri } from '@nullius/shared';
import Ajv2020 from 'ajv/dist/2020.js';

import artifactRefSchema from '../../../../meta/schemas/artifact_ref_v1.schema.json' with { type: 'json' };
import validationChainBindingSchema from '../../../../meta/schemas/validation_chain_binding_v1.schema.json' with { type: 'json' };
import validationCheckerVerdictSchema from '../../../../meta/schemas/validation_checker_verdict_v1.schema.json' with { type: 'json' };
import verificationCheckRunSchema from '../../../../meta/schemas/verification_check_run_v1.schema.json' with { type: 'json' };
import { createRunArtifactRef } from '../computation/artifact-refs.js';
import { assertDeclaredDependencyClosure, assertStepPathArgumentsDeclared, buildProductionEnvironment } from '../computation/dependency-closure.js';
import { assertComputationManifestValid } from '../computation/manifest.js';
import { assertNoSymlinkComponents, buildToolCommand, resolveWithinRoot } from '../computation/path-safety.js';
import {
  assertNativeRuntimeIdentityLive,
  isNativeRuntimeIdentity,
  type NativeRuntimeIdentity,
  resolveCanonicalNativeRuntime,
} from '../computation/runtime-identity.js';
import type {
  ExecutionStatusFile,
  ExternalDependencySnapshotEntry,
  StepExecutionSnapshotV1,
  WorkspaceFileSnapshotEntry,
} from '../computation/types.js';

type AjvConstructor = new (options: Record<string, unknown>) => {
  addSchema?: (schema: Record<string, unknown>, key?: string) => void;
  compile: (schema: Record<string, unknown>) => {
    (value: unknown): boolean;
    errors?: unknown[];
  };
};

export type BoundVerificationCheckRunV1 = DecisiveVerificationCheckRun;

export type LiveProductionBinding = Pick<ValidationChainBindingV1,
  | 'production_entry_ref'
  | 'production_config_ref'
  | 'production_execution_status_ref'
  | 'production_steps'
  | 'input_refs'>;

const ajv = new (Ajv2020 as unknown as AjvConstructor)({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
ajv.addSchema?.(
  artifactRefSchema as Record<string, unknown>,
  'https://nullius.dev/schemas/artifact_ref_v1.schema.json',
);
const bindingValidator = ajv.compile(validationChainBindingSchema as Record<string, unknown>);
const checkerVerdictValidator = ajv.compile(validationCheckerVerdictSchema as Record<string, unknown>);
const checkRunValidator = ajv.compile(verificationCheckRunSchema as Record<string, unknown>);

function validationError(message: string, details: Record<string, unknown> = {}): never {
  throw invalidParams(message, {
    validation_layer: 'validation_chain_binding',
    ...details,
  });
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameRef(left: ArtifactRefV1, right: ArtifactRefV1): boolean {
  return left.uri === right.uri && left.sha256 === right.sha256;
}

function refKey(ref: ArtifactRefV1): string {
  return `${ref.uri}\n${ref.sha256}`;
}

function sameRefSet(left: ArtifactRefV1[], right: ArtifactRefV1[]): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalEnvironmentHash(variables: Record<string, string>): string {
  const canonical = Object.entries(variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  return sha256Bytes(Buffer.from(canonical, 'utf-8'));
}

export function buildSanitizedCheckerEnvironment(
  runtime: NativeRuntimeIdentity,
  options: { pythonModulePath?: string } = {},
): SanitizedCheckerEnvironmentV1 {
  const runtimeDir = path.dirname(runtime.canonical_path);
  const pathEntries = [runtimeDir, '/usr/bin', '/bin'].filter(
    (value, index, values) => values.indexOf(value) === index,
  );
  const variables: Record<string, string> = {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: pathEntries.join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONSAFEPATH: '1',
    TZ: 'UTC',
  };
  if (options.pythonModulePath !== undefined) {
    variables.PYTHONPATH = path.resolve(options.pythonModulePath);
  }
  return {
    policy: 'nullius_checker_sanitized_v1',
    variables,
    sha256: canonicalEnvironmentHash(variables),
  };
}

function resolveInside(baseDir: string, candidate: string, label: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, candidate);
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    validationError(`${label} escapes its declared root.`, { candidate });
  }
  return resolved;
}

export function resolveVerifiedRunArtifact(
  runDir: string,
  runId: string,
  ref: ArtifactRefV1,
  label: string,
): { bytes: Buffer; filePath: string } {
  const parsed = parseScopedArtifactUri(ref.uri, { scheme: 'rep', scope: 'runs' });
  if (!parsed || parsed.scopeId !== runId) {
    validationError(`${label} must be a rep://runs reference for the current run.`, {
      run_id: runId,
      uri: ref.uri,
    });
  }
  const filePath = resolveInside(runDir, parsed.artifactName, label);
  assertNoSymlinkComponents(runDir, filePath, label);
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
    validationError(`${label} is missing.`, { uri: ref.uri, file_path: filePath });
  }
  const canonicalRunDir = fs.realpathSync.native(runDir);
  const canonicalFilePath = fs.realpathSync.native(filePath);
  const canonicalRelative = path.relative(canonicalRunDir, canonicalFilePath);
  if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
    validationError(`${label} resolves outside the current run directory.`, {
      uri: ref.uri,
      canonical_file_path: canonicalFilePath,
    });
  }
  const bytes = fs.readFileSync(filePath);
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== ref.sha256) {
    validationError(`${label} content hash does not match the recorded receipt.`, {
      uri: ref.uri,
      expected_sha256: ref.sha256,
      actual_sha256: actualSha256,
    });
  }
  if (ref.size_bytes !== undefined && ref.size_bytes !== bytes.length) {
    validationError(`${label} size does not match the recorded receipt.`, {
      uri: ref.uri,
      expected_size_bytes: ref.size_bytes,
      actual_size_bytes: bytes.length,
    });
  }
  return { bytes, filePath };
}

export function loadVerifiedRunJson<T>(
  runDir: string,
  runId: string,
  ref: ArtifactRefV1,
  label: string,
): T {
  const { bytes } = resolveVerifiedRunArtifact(runDir, runId, ref, label);
  try {
    return JSON.parse(bytes.toString('utf-8')) as T;
  } catch (error) {
    validationError(`${label} is not valid JSON.`, {
      uri: ref.uri,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function assertValidationChainBindingValid(raw: unknown): ValidationChainBindingV1 {
  if (!bindingValidator(raw)) {
    validationError('validation-chain receipt failed validation_chain_binding_v1 validation.', {
      issues: bindingValidator.errors ?? [],
    });
  }
  return raw as ValidationChainBindingV1;
}

export function assertValidationCheckerVerdictValid(raw: unknown): ValidationCheckerVerdictV1 {
  if (!checkerVerdictValidator(raw)) {
    validationError('checker verdict failed validation_checker_verdict_v1 validation.', {
      issues: checkerVerdictValidator.errors ?? [],
    });
  }
  return raw as ValidationCheckerVerdictV1;
}

export function assertVerificationCheckRunValid(raw: unknown): VerificationCheckRunV1 {
  if (!checkRunValidator(raw)) {
    validationError('verification check run failed verification_check_run_v1 validation.', {
      issues: checkRunValidator.errors ?? [],
    });
  }
  return raw as VerificationCheckRunV1;
}

export function assertBoundVerificationCheckRunValid(raw: unknown): BoundVerificationCheckRunV1 {
  const checkRun = assertVerificationCheckRunValid(raw);
  if (checkRun.check_role !== 'decisive' || !checkRun.validation_chain_binding_ref) {
    validationError('decisive verification check run is missing its validation-chain binding.');
  }
  return checkRun as BoundVerificationCheckRunV1;
}

export function prepareDirectCheckerExecution(params: {
  checkerRuntimeToken: string;
  checkerPath: string;
  projectRoot: string;
  requestPath: string;
  runDir: string;
  verdictPath: string;
  pythonHelperSearchPath?: string;
}): {
  command: string[];
  environment: SanitizedCheckerEnvironmentV1;
  runtime: NativeRuntimeIdentity;
} {
  const runtime = resolveCanonicalNativeRuntime({
    projectRoot: params.projectRoot,
    runDir: params.runDir,
    token: params.checkerRuntimeToken,
  });
  if (runtime.requested_token !== 'node' && !/^python(?:3(?:\.\d+)?)?$/u.test(runtime.requested_token)) {
    validationError('decisive checker runtime is not allowlisted; only Python and Node are supported.', {
      runtime_token: params.checkerRuntimeToken,
    });
  }
  assertNoSymlinkComponents(params.runDir, params.checkerPath, 'checker_path');
  const environment = buildSanitizedCheckerEnvironment(runtime, {
    pythonModulePath: /^python(?:3(?:\.\d+)?)?$/u.test(runtime.requested_token)
      ? params.pythonHelperSearchPath
      : undefined,
  });
  return {
    runtime,
    environment,
    command: [
    runtime.canonical_path,
    params.checkerPath,
    '--nullius-request',
    params.requestPath,
    '--nullius-verdict',
    params.verdictPath,
    ],
  };
}

function assertExecutionStatusValid(raw: unknown, runId: string): ExecutionStatusFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    validationError('production execution status is malformed.');
  }
  const status = raw as Partial<ExecutionStatusFile>;
  if (
    status.schema_version !== 1
    || status.run_id !== runId
    || status.status !== 'completed'
    || typeof status.manifest_sha256 !== 'string'
    || !status.entry_point
    || typeof status.entry_point.script !== 'string'
    || !/^[0-9a-f]{64}$/u.test(status.entry_point.sha256 ?? '')
    || !Array.isArray(status.steps)
    || status.steps.length === 0
  ) {
    validationError('production execution status lacks the immutable step binding required by A5.');
  }
  for (const [index, step] of status.steps.entries()) {
    if (
      !step
      || typeof step.id !== 'string'
      || step.status !== 'completed'
      || step.exit_code !== 0
      || !isNativeRuntimeIdentity(step.runtime_identity)
      || !step.execution_environment
      || !/^[0-9a-f]{64}$/u.test(step.script_pre_sha256 ?? '')
      || !/^[0-9a-f]{64}$/u.test(step.script_post_sha256 ?? '')
      || typeof step.pre_snapshot_path !== 'string'
      || !/^[0-9a-f]{64}$/u.test(step.pre_snapshot_sha256 ?? '')
      || typeof step.post_snapshot_path !== 'string'
      || !/^[0-9a-f]{64}$/u.test(step.post_snapshot_sha256 ?? '')
      || !Array.isArray(step.output_refs)
    ) {
      validationError('production execution status has an incomplete step provenance record.', {
        step_index: index,
      });
    }
  }
  return status as ExecutionStatusFile;
}

function readJsonBytes<T>(bytes: Buffer, label: string): T {
  try {
    return JSON.parse(bytes.toString('utf-8')) as T;
  } catch (error) {
    validationError(`${label} is not valid JSON.`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isWorkspaceSnapshotEntry(value: unknown): value is WorkspaceFileSnapshotEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Partial<WorkspaceFileSnapshotEntry>;
  return typeof ref.relative_path === 'string'
    && ref.relative_path.length > 0
    && /^[0-9a-f]{64}$/u.test(ref.sha256 ?? '')
    && Number.isInteger(ref.size_bytes)
    && (ref.size_bytes ?? -1) >= 0;
}

function isExternalSnapshotEntry(value: unknown): value is ExternalDependencySnapshotEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Partial<ExternalDependencySnapshotEntry>;
  return typeof ref.canonical_path === 'string'
    && path.isAbsolute(ref.canonical_path)
    && /^[0-9a-f]{64}$/u.test(ref.sha256 ?? '')
    && Number.isInteger(ref.size_bytes)
    && (ref.size_bytes ?? -1) >= 0;
}

function assertStepSnapshot(
  raw: unknown,
  params: { phase: StepExecutionSnapshotV1['phase']; stepId: string },
): StepExecutionSnapshotV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    validationError('step execution snapshot is malformed.', params);
  }
  const snapshot = raw as Partial<StepExecutionSnapshotV1>;
  const workspaceRefsValid = snapshot.workspace_file_refs === undefined
    || (Array.isArray(snapshot.workspace_file_refs) && snapshot.workspace_file_refs.every(isWorkspaceSnapshotEntry));
  const externalRefsValid = snapshot.external_dependency_refs === undefined
    || (Array.isArray(snapshot.external_dependency_refs) && snapshot.external_dependency_refs.every(isExternalSnapshotEntry));
  const outputRefsValid = snapshot.output_refs === undefined
    || (Array.isArray(snapshot.output_refs) && snapshot.output_refs.every(isWorkspaceSnapshotEntry));
  if (
    snapshot.schema_version !== 1
    || snapshot.phase !== params.phase
    || snapshot.step_id !== params.stepId
    || typeof snapshot.captured_at !== 'string'
    || !isWorkspaceSnapshotEntry(snapshot.manifest_ref)
    || !isWorkspaceSnapshotEntry(snapshot.script_ref)
    || !isNativeRuntimeIdentity(snapshot.runtime_identity)
    || !snapshot.execution_environment
    || snapshot.external_dependency_closure !== 'declared_and_locked_not_syscall_traced'
    || !workspaceRefsValid
    || !externalRefsValid
    || !outputRefsValid
    || (params.phase === 'pre_spawn' && (!snapshot.workspace_file_refs || snapshot.workspace_file_refs.length === 0))
    || (params.phase === 'post_exit' && (!snapshot.workspace_file_refs || !snapshot.output_refs))
  ) {
    validationError('step execution snapshot lacks required content-addressed provenance.', params);
  }
  return snapshot as StepExecutionSnapshotV1;
}

function workspaceSnapshotRef(params: {
  entry: WorkspaceFileSnapshotEntry;
  kind: string;
  runDir: string;
  runId: string;
  workspaceDir: string;
  label: string;
}): ArtifactRefV1 {
  const filePath = resolveWithinRoot(params.workspaceDir, params.entry.relative_path, params.label);
  assertNoSymlinkComponents(params.workspaceDir, filePath, params.label);
  if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
    validationError(`${params.label} is missing.`, { relative_path: params.entry.relative_path });
  }
  const bytes = fs.readFileSync(filePath);
  if (bytes.length !== params.entry.size_bytes || sha256Bytes(bytes) !== params.entry.sha256) {
    validationError(`${params.label} no longer matches its adjacent execution snapshot.`, {
      relative_path: params.entry.relative_path,
    });
  }
  return createRunArtifactRef(params.runId, params.runDir, filePath, params.kind);
}

function assertExternalDependenciesLive(refs: ExternalDependencySnapshotEntry[], label: string): void {
  for (const ref of refs) {
    if (!fs.existsSync(ref.canonical_path) || !fs.lstatSync(ref.canonical_path).isFile()) {
      validationError(`${label} is missing.`, { canonical_path: ref.canonical_path });
    }
    const canonical = fs.realpathSync.native(ref.canonical_path);
    const bytes = fs.readFileSync(canonical);
    if (canonical !== ref.canonical_path || bytes.length !== ref.size_bytes || sha256Bytes(bytes) !== ref.sha256) {
      validationError(`${label} no longer matches its content-addressed declaration.`, {
        canonical_path: ref.canonical_path,
      });
    }
  }
}

function sameSnapshotEntries<T extends WorkspaceFileSnapshotEntry | ExternalDependencySnapshotEntry>(
  left: T[],
  right: T[],
): boolean {
  const canonical = (value: T): string => JSON.stringify(value);
  const leftValues = left.map(canonical).sort();
  const rightValues = right.map(canonical).sort();
  return leftValues.length === rightValues.length
    && leftValues.every((value, index) => value === rightValues[index]);
}

export function buildLiveProductionBinding(params: {
  computationResult: ComputationResultV1;
  projectRoot: string;
  runDir: string;
  runId: string;
}): LiveProductionBinding {
  const configRef = params.computationResult.manifest_ref;
  const configArtifact = resolveVerifiedRunArtifact(
    params.runDir,
    params.runId,
    configRef,
    'production configuration',
  );
  let manifest: ComputationManifestV1;
  try {
    manifest = assertComputationManifestValid(readJsonBytes<unknown>(configArtifact.bytes, 'production configuration'));
  } catch (error) {
    validationError('production configuration is not a valid computation manifest.', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const executionStatusRef = params.computationResult.produced_artifact_refs.find(
    ref => ref.kind === 'execution_status',
  );
  if (!executionStatusRef) {
    validationError('canonical computation result is missing its production execution-status receipt.');
  }
  const executionStatus = assertExecutionStatusValid(loadVerifiedRunJson<unknown>(
    params.runDir,
    params.runId,
    executionStatusRef,
    'production execution status',
  ), params.runId);
  if (executionStatus.manifest_sha256 !== configRef.sha256) {
    validationError('production execution status and current manifest have different hashes.');
  }

  const manifestStepsById = new Map(manifest.steps.map(step => [step.id, step] as const));
  if (
    manifestStepsById.size !== manifest.steps.length
    || executionStatus.steps.length !== manifest.steps.length
    || new Set(executionStatus.steps.map(step => step.id)).size !== manifest.steps.length
  ) {
    validationError('production execution status does not cover every manifest step exactly once.');
  }
  const entryMatches = manifest.steps.filter(step => step.script === manifest.entry_point.script);
  if (entryMatches.length !== 1) {
    validationError('entry_point.script must identify exactly one actual executed step.', {
      entry_point: manifest.entry_point.script,
      matching_steps: entryMatches.map(step => step.id),
    });
  }
  const entryStep = entryMatches[0]!;
  const entryArgs = manifest.entry_point.args ?? [];
  const entryStepArgs = entryStep.args ?? [];
  if (
    (manifest.entry_point.tool !== undefined && manifest.entry_point.tool !== entryStep.tool)
    || !sameStringArray(entryArgs, entryStepArgs)
  ) {
    validationError('entry_point tool and arguments do not exactly match its unique executed step.');
  }
  const entryPath = resolveInside(path.dirname(configArtifact.filePath), manifest.entry_point.script, 'production entry');
  const productionEntryRef = createRunArtifactRef(params.runId, params.runDir, entryPath, 'production_entry');
  if (
    executionStatus.entry_point.script !== manifest.entry_point.script
    || executionStatus.entry_point.sha256 !== productionEntryRef.sha256
  ) {
    validationError('recorded production entry does not match the unique executed entry step.');
  }

  const structuredResultRefs = params.computationResult.produced_artifact_refs.filter(
    ref => ref.kind === 'structured_result',
  );
  const executionLogRefs = params.computationResult.produced_artifact_refs.filter(
    ref => ref.kind === 'execution_log',
  );
  if (structuredResultRefs.length === 0) {
    validationError('decisive verification requires at least one structured production output.');
  }
  const expectedAllOutputs: ArtifactRefV1[] = [];
  const expectedAllLogs: ArtifactRefV1[] = [];
  const workspaceDir = path.dirname(configArtifact.filePath);
  const productionSteps: ProductionStepBinding[] = executionStatus.steps.map((statusStep) => {
    const manifestStep = manifestStepsById.get(statusStep.id);
    if (!manifestStep) {
      validationError('execution status contains a step absent from the manifest.', { step_id: statusStep.id });
    }
    if (statusStep.status !== 'completed' || statusStep.exit_code !== 0) {
      validationError('decisive verification requires each production step to have completed with exit code zero.', {
        step_id: statusStep.id,
      });
    }
    const exitStatus = statusStep.exit_code;
    assertNativeRuntimeIdentityLive({
      identity: statusStep.runtime_identity,
      projectRoot: params.projectRoot,
      runDir: params.runDir,
    });
    if (statusStep.script !== manifestStep.script) {
      validationError('execution status step script differs from the manifest step.', { step_id: statusStep.id });
    }
    const manifestExpectedOutputs = manifestStep.expected_outputs ?? [];
    if (!sameStringArray(statusStep.expected_outputs, manifestExpectedOutputs)) {
      validationError('execution status expected outputs differ from the manifest.', { step_id: statusStep.id });
    }
    const scriptPath = resolveInside(workspaceDir, statusStep.script, `step ${statusStep.id} script`);
    assertNoSymlinkComponents(workspaceDir, scriptPath, `step ${statusStep.id} script`);
    const expectedCommand = buildToolCommand(
      manifestStep.tool,
      scriptPath,
      (manifestStep.args ?? []).map(value => String(value)),
      statusStep.runtime_identity.canonical_path,
    );
    const manifestStepWithEnv = manifestStep as typeof manifestStep & { env?: Record<string, string> };
    const expectedEnvironment = buildProductionEnvironment(
      statusStep.runtime_identity,
      manifestStepWithEnv.env ?? (manifestStep.script === manifest.entry_point.script ? (manifest.entry_point.env ?? {}) : {}),
    );
    if (JSON.stringify(statusStep.execution_environment) !== JSON.stringify(expectedEnvironment)) {
      validationError('execution status environment is not the exact sanitized environment compiled from the manifest.', { step_id: statusStep.id });
    }
    if (!sameStringArray(statusStep.command, expectedCommand)) {
      validationError('execution status command is not the exact structured argv compiled from the manifest step.', {
        step_id: statusStep.id,
      });
    }
    const logDir = resolveInside(workspaceDir, statusStep.log_dir, `step ${statusStep.id} log directory`);
    assertNoSymlinkComponents(workspaceDir, logDir, `step ${statusStep.id} log directory`);
    const stdoutRef = createRunArtifactRef(params.runId, params.runDir, path.join(logDir, 'stdout.txt'), 'execution_log');
    const stderrRef = createRunArtifactRef(params.runId, params.runDir, path.join(logDir, 'stderr.txt'), 'execution_log');
    const metaPath = path.join(logDir, 'meta.json');
    const metaRef = createRunArtifactRef(params.runId, params.runDir, metaPath, 'execution_log');
    const preSnapshotPath = resolveInside(workspaceDir, statusStep.pre_snapshot_path, `step ${statusStep.id} pre snapshot`);
    const postSnapshotPath = resolveInside(workspaceDir, statusStep.post_snapshot_path, `step ${statusStep.id} post snapshot`);
    assertNoSymlinkComponents(workspaceDir, preSnapshotPath, `step ${statusStep.id} pre snapshot`);
    assertNoSymlinkComponents(workspaceDir, postSnapshotPath, `step ${statusStep.id} post snapshot`);
    const preSnapshotRef = createRunArtifactRef(params.runId, params.runDir, preSnapshotPath, 'execution_log');
    const postSnapshotRef = createRunArtifactRef(params.runId, params.runDir, postSnapshotPath, 'execution_log');
    if (preSnapshotRef.sha256 !== statusStep.pre_snapshot_sha256 || postSnapshotRef.sha256 !== statusStep.post_snapshot_sha256) {
      validationError('adjacent step snapshot hash differs from execution status.', { step_id: statusStep.id });
    }
    expectedAllLogs.push(stdoutRef, stderrRef, metaRef, preSnapshotRef, postSnapshotRef);
    const preSnapshot = assertStepSnapshot(
      readJsonBytes<unknown>(fs.readFileSync(preSnapshotPath), `step ${statusStep.id} pre snapshot`),
      { phase: 'pre_spawn', stepId: statusStep.id },
    );
    const postSnapshot = assertStepSnapshot(
      readJsonBytes<unknown>(fs.readFileSync(postSnapshotPath), `step ${statusStep.id} post snapshot`),
      { phase: 'post_exit', stepId: statusStep.id },
    );
    if (
      JSON.stringify(preSnapshot.runtime_identity) !== JSON.stringify(statusStep.runtime_identity)
      || JSON.stringify(postSnapshot.runtime_identity) !== JSON.stringify(statusStep.runtime_identity)
      || JSON.stringify(preSnapshot.execution_environment) !== JSON.stringify(statusStep.execution_environment)
      || JSON.stringify(postSnapshot.execution_environment) !== JSON.stringify(statusStep.execution_environment)
      || preSnapshot.script_ref.sha256 !== statusStep.script_pre_sha256
      || postSnapshot.script_ref.sha256 !== statusStep.script_post_sha256
      || preSnapshot.manifest_ref.sha256 !== configRef.sha256
      || postSnapshot.manifest_ref.sha256 !== configRef.sha256
    ) {
      validationError('step snapshots do not match the executed runtime, manifest, or script hashes.', {
        step_id: statusStep.id,
      });
    }
    const externalDependencyRefs = preSnapshot.external_dependency_refs ?? [];
    if (!sameSnapshotEntries(externalDependencyRefs, postSnapshot.external_dependency_refs ?? [])) {
      validationError('external dependency refs changed across step execution.', { step_id: statusStep.id });
    }
    assertExternalDependenciesLive(externalDependencyRefs, `step ${statusStep.id} external dependency`);
    const workspaceRefs = preSnapshot.workspace_file_refs ?? [];
    if (!sameSnapshotEntries(workspaceRefs, postSnapshot.workspace_file_refs ?? [])) {
      validationError('workspace implementation/input refs changed across step execution.', {
        step_id: statusStep.id,
      });
    }
    const implementationInputRefs = workspaceRefs.map((entry, index) => workspaceSnapshotRef({
      entry,
      kind: 'production_implementation_input',
      label: `step ${statusStep.id} implementation input ${index}`,
      runDir: params.runDir,
      runId: params.runId,
      workspaceDir,
    }));
    if (implementationInputRefs.length === 0) {
      validationError('step snapshot must bind at least one implementation or input file.', {
        step_id: statusStep.id,
      });
    }
    assertDeclaredDependencyClosure({
      externalRefs: externalDependencyRefs,
      manifest,
      workspaceDir,
      workspaceRefs,
    });
    assertStepPathArgumentsDeclared({
      externalRefs: externalDependencyRefs,
      manifest,
      workspaceDir,
    });
    const scriptRef = workspaceSnapshotRef({
      entry: preSnapshot.script_ref,
      kind: 'production_step_script',
      label: `step ${statusStep.id} script`,
      runDir: params.runDir,
      runId: params.runId,
      workspaceDir,
    });
    const outputSnapshotRefs = postSnapshot.output_refs ?? [];
    if (!sameSnapshotEntries(outputSnapshotRefs, statusStep.output_refs)) {
      validationError('post-exit output refs differ from execution status.', { step_id: statusStep.id });
    }
    const outputRefs = outputSnapshotRefs.map((entry, index) => workspaceSnapshotRef({
      entry,
      kind: 'structured_result',
      label: `step ${statusStep.id} output ${index}`,
      runDir: params.runDir,
      runId: params.runId,
      workspaceDir,
    }));
    const expectedOutputPaths = manifestExpectedOutputs.map(output =>
      resolveInside(workspaceDir, output, `step ${statusStep.id} expected output`));
    const actualOutputPaths = outputSnapshotRefs.map(entry =>
      resolveInside(workspaceDir, entry.relative_path, `step ${statusStep.id} snapshot output`));
    if (
      expectedOutputPaths.length !== actualOutputPaths.length
      || expectedOutputPaths.sort().some((value, index) => value !== actualOutputPaths.sort()[index])
    ) {
      validationError('post-exit snapshot does not cover exactly the manifest-declared outputs.', {
        step_id: statusStep.id,
      });
    }
    expectedAllOutputs.push(...outputRefs);
    const meta = readJsonBytes<{
      command?: unknown;
      exit_code?: unknown;
      output_refs?: unknown;
      post_snapshot_sha256?: unknown;
      pre_snapshot_sha256?: unknown;
      runtime_identity?: unknown;
      execution_environment?: unknown;
      script_post_sha256?: unknown;
      script_pre_sha256?: unknown;
    }>(fs.readFileSync(metaPath), `step ${statusStep.id} execution metadata`);
    if (
      !Array.isArray(meta.command)
      || !sameStringArray(meta.command as string[], statusStep.command)
      || meta.exit_code !== statusStep.exit_code
      || JSON.stringify(meta.runtime_identity) !== JSON.stringify(statusStep.runtime_identity)
      || JSON.stringify(meta.execution_environment) !== JSON.stringify(statusStep.execution_environment)
      || meta.pre_snapshot_sha256 !== statusStep.pre_snapshot_sha256
      || meta.post_snapshot_sha256 !== statusStep.post_snapshot_sha256
      || meta.script_pre_sha256 !== statusStep.script_pre_sha256
      || meta.script_post_sha256 !== statusStep.script_post_sha256
      || JSON.stringify(meta.output_refs) !== JSON.stringify(statusStep.output_refs)
    ) {
      validationError('step execution metadata does not match the recorded command and exit status.', {
        step_id: statusStep.id,
      });
    }
    return {
      id: statusStep.id,
      command: statusStep.command as ProductionStepBinding['command'],
      runtime_identity: statusStep.runtime_identity,
      execution_environment: statusStep.execution_environment,
      script_ref: scriptRef,
      pre_snapshot_ref: preSnapshotRef,
      post_snapshot_ref: postSnapshotRef,
      implementation_input_refs: implementationInputRefs as ProductionStepBinding['implementation_input_refs'],
      external_dependency_refs: externalDependencyRefs,
      output_refs: outputRefs,
      exit_status: exitStatus,
      stdout_ref: stdoutRef,
      stderr_ref: stderrRef,
      meta_ref: metaRef,
    };
  });
  if (!sameRefSet(expectedAllOutputs, structuredResultRefs)) {
    validationError('canonical structured outputs do not exactly match all outputs of all executed steps.');
  }
  if (!sameRefSet(expectedAllLogs, executionLogRefs)) {
    validationError('canonical execution logs do not exactly match stdout, stderr, metadata, and adjacent snapshots for every executed step.');
  }
  for (const [index, ref] of structuredResultRefs.entries()) {
    resolveVerifiedRunArtifact(params.runDir, params.runId, ref, `structured production output ${index}`);
  }
  return {
    production_entry_ref: productionEntryRef,
    production_config_ref: configRef,
    production_execution_status_ref: executionStatusRef,
    production_steps: productionSteps as ValidationChainBindingV1['production_steps'],
    input_refs: structuredResultRefs as ValidationChainBindingV1['input_refs'],
  };
}

function expectedCheckStatus(
  verdict: ValidationCheckerVerdictV1['status'],
): VerificationCheckRunV1['status'] {
  if (verdict === 'pass') return 'passed';
  if (verdict === 'fail') return 'failed';
  return 'blocked';
}

function artifactRelativePath(ref: ArtifactRefV1, runId: string): string {
  const parsed = parseScopedArtifactUri(ref.uri, { scheme: 'rep', scope: 'runs' });
  if (!parsed || parsed.scopeId !== runId) validationError('Production output ref is outside the current run.', { uri: ref.uri });
  return parsed.artifactName.split(path.sep).join('/');
}

export function assertCheckerObservedRequiredSurface(params: {
  expectedOutputRefs: ArtifactRefV1[];
  request: ValidationCheckerRequestV1;
  verdict: ValidationCheckerVerdictV1;
}): void {
  const { request, verdict } = params;
  if (verdict.quantity_id !== request.quantity_id || verdict.layer_id !== request.layer_id) {
    validationError('Checker verdict quantity/layer differs from the required semantic surface.');
  }
  const sameStrings = (left: string[], right: string[]) => {
    const a = [...new Set(left)].sort();
    const b = [...new Set(right)].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  };
  if (!sameStrings(verdict.disputed_dimensions, request.disputed_dimensions)) {
    validationError('Checker verdict did not retain exactly the required disputed dimensions.');
  }
  const targets = new Map(request.output_targets.map(target => [target.uri, target] as const));
  const expected = new Map(params.expectedOutputRefs.map(ref => [ref.uri, ref] as const));
  const observed = new Map(verdict.consumed_output_observations.map(item => [item.uri, item] as const));
  if (targets.size !== request.output_targets.length || observed.size !== verdict.consumed_output_observations.length
    || expected.size !== params.expectedOutputRefs.length || targets.size !== expected.size || observed.size !== expected.size) {
    validationError('Checker consumed-output observations have missing, duplicate, or extra entries.');
  }
  for (const [uri, ref] of expected) {
    const target = targets.get(uri);
    const item = observed.get(uri);
    const expectedPath = artifactRelativePath(ref, request.run_id);
    if (!target || target.path !== expectedPath || !item || item.path !== expectedPath || item.sha256 !== ref.sha256) {
      validationError('Checker output observation does not match the internally bound production bytes.', { uri });
    }
  }
  const results = new Map(verdict.negative_control_results.map(result => [result.control_id, result] as const));
  if (results.size !== verdict.negative_control_results.length
    || !sameStrings([...results.keys()], request.required_negative_control_ids)) {
    validationError('Checker verdict is missing or adds required negative-control results.');
  }
  if (verdict.status === 'pass' && [...results.values()].some(result => result.status !== 'pass')) {
    validationError('Checker cannot emit pass when a required negative control did not pass.');
  }
}

function requestProjection(binding: ValidationChainBindingV1, checkKind: string): ValidationCheckerRequestV1 {
  return {
    schema_version: 1,
    run_id: binding.run_id,
    subject_id: binding.subject_id,
    check_kind: checkKind,
    quantity_id: binding.quantity_id,
    layer_id: binding.layer_id,
    reference_provenance: binding.reference_provenance,
    disputed_dimensions: binding.disputed_dimensions,
    required_negative_control_ids: binding.required_negative_control_ids,
    output_targets: binding.input_refs.map(ref => ({
      uri: ref.uri,
      path: artifactRelativePath(ref, binding.run_id),
    })) as ValidationCheckerRequestV1['output_targets'],
    checker_ref: binding.checker_ref,
    checker_helper_refs: binding.checker_helper_refs,
    checker_runtime: binding.checker_runtime,
    checker_environment: binding.checker_environment,
  };
}

export function validateValidationChainBinding(params: {
  bindingRef: ArtifactRefV1;
  checkRun: BoundVerificationCheckRunV1;
  computationResult: ComputationResultV1;
  expectedSubjectId: string;
  projectRoot: string;
  runDir: string;
  runId: string;
}): ValidationChainBindingV1 {
  const bindingArtifact = resolveVerifiedRunArtifact(
    params.runDir,
    params.runId,
    params.bindingRef,
    'validation-chain binding receipt',
  );
  const binding = assertValidationChainBindingValid(
    readJsonBytes<unknown>(bindingArtifact.bytes, 'validation-chain binding receipt'),
  );
  if (binding.run_id !== params.runId || binding.subject_id !== params.expectedSubjectId) {
    validationError('validation-chain receipt does not match the current run and verification subject.');
  }
  if (!sameRef(params.checkRun.validation_chain_binding_ref, params.bindingRef)) {
    validationError('verification check run does not reference the exact validation-chain receipt bytes.');
  }
  if (
    params.checkRun.run_id !== params.runId
    || params.checkRun.subject_id !== params.expectedSubjectId
    || params.checkRun.check_role !== 'decisive'
  ) {
    validationError('verification check run provenance is not a decisive check of the current subject.');
  }

  const live = buildLiveProductionBinding({
    computationResult: params.computationResult,
    projectRoot: params.projectRoot,
    runDir: params.runDir,
    runId: params.runId,
  });
  if (
    !sameRef(binding.production_entry_ref, live.production_entry_ref)
    || !sameRef(binding.production_config_ref, live.production_config_ref)
    || !sameRef(binding.production_execution_status_ref, live.production_execution_status_ref)
    || !sameRefSet(binding.input_refs, live.input_refs)
    || JSON.stringify(binding.production_steps) !== JSON.stringify(live.production_steps)
  ) {
    validationError('validation-chain receipt no longer matches the live manifest, actual steps, outputs, or execution evidence.');
  }
  if (!sameRefSet(params.checkRun.evidence_refs, binding.input_refs)) {
    validationError('verification evidence refs do not exactly cover all structured production outputs.');
  }

  const checkerArtifact = resolveVerifiedRunArtifact(params.runDir, params.runId, binding.checker_ref, 'decisive checker');
  binding.checker_helper_refs.forEach((ref, index) => {
    resolveVerifiedRunArtifact(params.runDir, params.runId, ref, `decisive checker helper ${index}`);
  });
  const requestArtifact = resolveVerifiedRunArtifact(params.runDir, params.runId, binding.checker_request_ref, 'checker request');
  const verdictArtifact = resolveVerifiedRunArtifact(params.runDir, params.runId, binding.structured_verdict_ref, 'checker verdict');
  const stdoutArtifact = resolveVerifiedRunArtifact(params.runDir, params.runId, binding.execution.stdout_ref, 'checker stdout');
  const stderrArtifact = resolveVerifiedRunArtifact(params.runDir, params.runId, binding.execution.stderr_ref, 'checker stderr');
  void stdoutArtifact;
  void stderrArtifact;
  const request = readJsonBytes<ValidationCheckerRequestV1>(requestArtifact.bytes, 'checker request');
  if (JSON.stringify(request) !== JSON.stringify(requestProjection(binding, params.checkRun.check_kind))) {
    validationError('checker request does not exactly bind the receipt production inputs and checker.');
  }
  const verdict = assertValidationCheckerVerdictValid(readJsonBytes<unknown>(verdictArtifact.bytes, 'checker verdict'));
  if (verdict.request_sha256 !== sha256Bytes(requestArtifact.bytes)) {
    validationError('checker verdict is not bound to the exact checker request bytes.');
  }
  if (
    params.checkRun.check_kind !== verdict.check_kind
    || params.checkRun.status !== expectedCheckStatus(verdict.status)
    || params.checkRun.summary !== verdict.summary
  ) {
    validationError('check-run kind, status, and summary must be derived verbatim from the checker verdict.');
  }
  assertCheckerObservedRequiredSurface({
    expectedOutputRefs: binding.input_refs,
    request,
    verdict,
  });
  if (verdict.status === 'pass' ? binding.execution.exit_status !== 0 : binding.execution.exit_status === 0) {
    validationError('checker exit status conflicts with its structured verdict.');
  }
  assertNativeRuntimeIdentityLive({
    identity: binding.checker_runtime,
    projectRoot: params.projectRoot,
    runDir: params.runDir,
  });
  const expectedExecution = prepareDirectCheckerExecution({
    checkerRuntimeToken: binding.checker_runtime.requested_token,
    checkerPath: checkerArtifact.filePath,
    projectRoot: params.projectRoot,
    requestPath: requestArtifact.filePath,
    runDir: params.runDir,
    verdictPath: verdictArtifact.filePath,
    pythonHelperSearchPath: binding.checker_helper_refs.length > 0
      ? path.dirname(checkerArtifact.filePath)
      : undefined,
  });
  if (
    JSON.stringify(expectedExecution.runtime) !== JSON.stringify(binding.checker_runtime)
    || JSON.stringify(expectedExecution.environment) !== JSON.stringify(binding.checker_environment)
    || canonicalEnvironmentHash(binding.checker_environment.variables) !== binding.checker_environment.sha256
  ) {
    validationError('recorded checker runtime or sanitized environment no longer matches its live identity.');
  }
  if (!sameStringArray(binding.execution.command, expectedExecution.command)) {
    validationError('recorded checker command is not the exact direct structured argv executed by Nullius.');
  }
  const expectedCheckOutputs = [
    binding.checker_request_ref,
    binding.structured_verdict_ref,
    binding.execution.stdout_ref,
    binding.execution.stderr_ref,
  ];
  if (!sameRefSet(params.checkRun.output_artifact_refs ?? [], expectedCheckOutputs)) {
    validationError('verification check run does not bind all checker request, verdict, and process-log outputs.');
  }
  return binding;
}
