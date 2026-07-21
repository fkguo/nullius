import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { invalidParams, notFound, type ComputationManifestV1 } from '@nullius/shared';
import computationManifestSchema from '../../../../meta/schemas/computation_manifest_v1.schema.json' with { type: 'json' };
import { sha256File, toPosixRelative } from './io.js';
import {
  assertCommandAllowed,
  assertNoSymlinkComponents,
  buildToolCommand,
  resolveWithinRoot,
  runtimeTokenForTool,
  sanitizeRelativePath,
} from './path-safety.js';
import { resolveCanonicalNativeRuntime } from './runtime-identity.js';
import { buildProductionEnvironment } from './dependency-closure.js';
import type { ExecuteComputationManifestInput, PreparedManifest, StepCommandPlan } from './types.js';

type AjvConstructor = new (options: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => {
    (value: unknown): boolean;
    errors?: unknown[];
  };
};

const Ajv2020Ctor = Ajv2020 as unknown as AjvConstructor;

const validator = new Ajv2020Ctor({ allErrors: true, strict: false, validateFormats: false }).compile(
  computationManifestSchema as Record<string, unknown>,
);

function manifestSchemaError(message: string, details: Record<string, unknown> = {}): never {
  throw invalidParams(message, { validation_layer: 'manifest_schema', ...details });
}

function readinessError(message: string, details: Record<string, unknown> = {}): never {
  throw invalidParams(message, { validation_layer: 'dry_run_readiness', ...details });
}

export function assertComputationManifestValid(raw: unknown): ComputationManifestV1 {
  if (!validator(raw)) {
    manifestSchemaError('manifest failed computation_manifest_v1 validation', {
      issues: validator.errors ?? [],
    });
  }
  return raw as ComputationManifestV1;
}

function topologicalOrder(steps: ComputationManifestV1['steps']): string[] {
  const nodes = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const step of steps) {
    nodes.set(step.id, new Set(step.depends_on ?? []));
    reverse.set(step.id, new Set());
  }
  for (const [id, deps] of nodes.entries()) {
    for (const dep of deps) {
      if (!nodes.has(dep)) {
        readinessError(`step '${id}' depends on unknown step '${dep}'`);
      }
      reverse.get(dep)!.add(id);
    }
  }
  const ready = [...nodes.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const child of [...(reverse.get(next) ?? [])].sort()) {
      const deps = nodes.get(child)!;
      deps.delete(next);
      if (deps.size === 0 && !order.includes(child) && !ready.includes(child)) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  if (order.length !== steps.length) {
    readinessError('step dependency graph contains a cycle');
  }
  return order;
}

export function prepareManifest(input: ExecuteComputationManifestInput): PreparedManifest {
  if (!fs.existsSync(input.manifestPath)) {
    throw notFound(`manifest not found: ${input.manifestPath}`);
  }
  assertNoSymlinkComponents(input.runDir, input.manifestPath, 'manifest_path');
  const raw = JSON.parse(fs.readFileSync(input.manifestPath, 'utf-8')) as unknown;
  const manifest = assertComputationManifestValid(raw);
  const workspaceDir = path.dirname(resolveWithinRoot(input.runDir, input.manifestPath, 'manifest_path'));
  const dependencies = manifest.dependencies as ComputationManifestV1['dependencies'] & {
    external_dependency_refs?: Array<{ path: string }>;
  };
  for (const [index, ref] of (dependencies.external_dependency_refs ?? []).entries()) {
    if (!path.isAbsolute(ref.path)) {
      readinessError('external_dependency_refs paths must be absolute and must not depend on the caller working directory', {
        index,
        external_dependency_path: ref.path,
      });
    }
  }
  const manifestRelativePath = toPosixRelative(input.runDir, input.manifestPath);
  const seenIds = new Set<string>();
  const seenOutputPaths = new Map<string, string>();
  const steps: StepCommandPlan[] = manifest.steps.map((step: ComputationManifestV1['steps'][number]) => {
    if (seenIds.has(step.id)) {
      readinessError(`duplicate step id '${step.id}' in manifest`);
    }
    seenIds.add(step.id);
    if (!step.script) {
      readinessError(`step '${step.id}' is missing script`);
    }
    const scriptRelativePath = sanitizeRelativePath(step.script, `steps.${step.id}.script`);
    const scriptPath = resolveWithinRoot(workspaceDir, scriptRelativePath, `steps.${step.id}.script`);
    assertNoSymlinkComponents(workspaceDir, scriptPath, `steps.${step.id}.script`);
    if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
      readinessError(`step '${step.id}' script must resolve to an existing regular file`);
    }
    const args = (step.args ?? []).map((value: string) => String(value));
    const runtimeIdentity = resolveCanonicalNativeRuntime({
      projectRoot: input.projectRoot,
      runDir: input.runDir,
      token: runtimeTokenForTool(step.tool),
    });
    const stepWithEnv = step as typeof step & { env?: Record<string, string> };
    const entryEnv = step.script === manifest.entry_point.script ? (manifest.entry_point.env ?? {}) : {};
    const executionEnvironment = buildProductionEnvironment(runtimeIdentity, stepWithEnv.env ?? entryEnv);
    const argv = buildToolCommand(step.tool, scriptPath, args, runtimeIdentity.canonical_path);
    assertCommandAllowed(argv);
    const expectedOutputs = (step.expected_outputs ?? []).map((output: string) =>
      sanitizeRelativePath(output, `steps.${step.id}.expected_outputs`),
    );
    const expectedOutputPaths = expectedOutputs.map((output: string) =>
      resolveWithinRoot(workspaceDir, output, `steps.${step.id}.expected_outputs`),
    );
    for (const [index, outputPath] of expectedOutputPaths.entries()) {
      assertNoSymlinkComponents(
        workspaceDir,
        outputPath,
        `steps.${step.id}.expected_outputs[${index}]`,
        { allowMissingLeaf: true },
      );
      const previousOwner = seenOutputPaths.get(outputPath);
      if (previousOwner) {
        readinessError(`expected output '${expectedOutputs[index]}' is declared by more than one step`, {
          first_step_id: previousOwner,
          second_step_id: step.id,
        });
      }
      seenOutputPaths.set(outputPath, step.id);
    }
    return {
      id: step.id,
      tool: step.tool,
      argv,
      runtimeIdentity,
      executionEnvironment,
      scriptPath,
      scriptRelativePath,
      expectedOutputs,
      expectedOutputPaths,
      timeoutMinutes: step.timeout_minutes ?? null,
    };
  });
  const entryPointScript = sanitizeRelativePath(
    manifest.entry_point.script,
    'entry_point.script',
  );
  const entryPointScriptPath = resolveWithinRoot(workspaceDir, entryPointScript, 'entry_point.script');
  assertNoSymlinkComponents(workspaceDir, entryPointScriptPath, 'entry_point.script');
  if (!fs.existsSync(entryPointScriptPath) || !fs.statSync(entryPointScriptPath).isFile()) {
    readinessError('entry_point.script must resolve to an existing regular file');
  }
  return {
    manifest,
    manifestPath: input.manifestPath,
    manifestRelativePath,
    manifestSha256: sha256File(input.manifestPath),
    entryPointScriptPath,
    entryPointScriptRelativePath: entryPointScript,
    runId: input.runId,
    runDir: input.runDir,
    workspaceDir,
    stepOrder: topologicalOrder(manifest.steps),
    steps,
    topLevelOutputs: (manifest.outputs ?? []).map((output: string) =>
      toPosixRelative(input.runDir, resolveWithinRoot(workspaceDir, sanitizeRelativePath(output, 'outputs'), 'outputs')),
    ),
  };
}
