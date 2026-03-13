import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { invalidParams, notFound, type ComputationManifestV1 } from '@autoresearch/shared';
import computationManifestSchema from '../../../../meta/schemas/computation_manifest_v1.schema.json' with { type: 'json' };
import { sha256File, toPosixRelative } from './io.js';
import { assertCommandAllowed, buildToolCommand, resolveWithinRoot, sanitizeRelativePath } from './path-safety.js';
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
  const raw = JSON.parse(fs.readFileSync(input.manifestPath, 'utf-8')) as unknown;
  const manifest = assertComputationManifestValid(raw);
  const workspaceDir = path.dirname(resolveWithinRoot(input.runDir, input.manifestPath, 'manifest_path'));
  const manifestRelativePath = toPosixRelative(input.runDir, input.manifestPath);
  const seenIds = new Set<string>();
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
    const args = (step.args ?? []).map((value: string) => String(value));
    const argv = buildToolCommand(step.tool, scriptPath, args);
    assertCommandAllowed(argv);
    const expectedOutputs = (step.expected_outputs ?? []).map((output: string) =>
      sanitizeRelativePath(output, `steps.${step.id}.expected_outputs`),
    );
    return {
      id: step.id,
      tool: step.tool,
      argv,
      scriptPath,
      scriptRelativePath,
      expectedOutputs,
      expectedOutputPaths: expectedOutputs.map((output: string) =>
        resolveWithinRoot(workspaceDir, output, `steps.${step.id}.expected_outputs`),
      ),
      timeoutMinutes: step.timeout_minutes ?? null,
    };
  });
  const entryPointScript = sanitizeRelativePath(
    manifest.entry_point.script,
    'entry_point.script',
  );
  resolveWithinRoot(workspaceDir, entryPointScript, 'entry_point.script');
  return {
    manifest,
    manifestPath: input.manifestPath,
    manifestRelativePath,
    manifestSha256: sha256File(input.manifestPath),
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
