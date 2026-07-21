import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');
const schemaDir = path.join(repoRoot, 'meta', 'schemas');
const generatedDir = path.join(repoRoot, 'packages', 'shared', 'src', 'generated');

function readJson(fileName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(schemaDir, fileName), 'utf-8')) as Record<string, unknown>;
}

function requiredFields(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required) ? schema.required as string[] : [];
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return (schema.properties ?? {}) as Record<string, unknown>;
}

function verificationCheckRunBase(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = (schema.$defs ?? {}) as Record<string, Record<string, unknown>>;
  return defs.VerificationCheckRunBase ?? {};
}

describe('verification kernel schema foundation', () => {
  it('keeps stable generic subject kinds while leaving check kinds open-ended', () => {
    const subjectSchema = readJson('verification_subject_v1.schema.json');
    const checkRunSchema = readJson('verification_check_run_v1.schema.json');
    const subjectKind = schemaProperties(subjectSchema).subject_kind as { enum?: string[] };
    const checkKind = schemaProperties(verificationCheckRunBase(checkRunSchema)).check_kind as { type?: string; enum?: string[] };

    expect(subjectKind.enum).toEqual([
      'claim',
      'result',
      'deliverable',
      'acceptance_test',
      'reference_action',
      'forbidden_proxy',
      'comparison_target',
    ]);
    expect(checkKind.type).toBe('string');
    expect(checkKind.enum).toBeUndefined();
  });

  it('makes missing decisive checks required and machine-visible', () => {
    const verdictSchema = readJson('verification_subject_verdict_v1.schema.json');
    const coverageSchema = readJson('verification_coverage_v1.schema.json');
    const verdictMissing = schemaProperties(verdictSchema).missing_decisive_checks as { items?: { $ref?: string } };
    const coverageMissing = schemaProperties(coverageSchema).missing_decisive_checks as { items?: { $ref?: string } };

    expect(requiredFields(verdictSchema)).toContain('missing_decisive_checks');
    expect(requiredFields(coverageSchema)).toContain('missing_decisive_checks');
    expect(verdictMissing.items?.$ref).toBe('#/$defs/MissingDecisiveCheck');
    expect(coverageMissing.items?.$ref).toBe('#/$defs/CoverageGap');
  });

  it('requires artifact-backed evidence for executed verification checks', () => {
    const checkRunSchema = readJson('verification_check_run_v1.schema.json');
    const checkRunBase = verificationCheckRunBase(checkRunSchema);
    const props = schemaProperties(checkRunBase);
    const subjectRef = props.subject_ref as { $ref?: string };
    const evidenceRefs = props.evidence_refs as { minItems?: number; items?: { $ref?: string } };

    expect(requiredFields(checkRunBase)).toContain('subject_ref');
    expect(requiredFields(checkRunBase)).toContain('evidence_refs');
    expect(subjectRef.$ref).toBe('https://nullius.dev/schemas/artifact_ref_v1.schema.json');
    expect(evidenceRefs.minItems).toBe(1);
    expect(evidenceRefs.items?.$ref).toBe('https://nullius.dev/schemas/artifact_ref_v1.schema.json');
  });

  it('requires decisive check runs to carry a validation-chain binding receipt', () => {
    const checkRunSchema = readJson('verification_check_run_v1.schema.json');
    const bindingSchema = readJson('validation_chain_binding_v1.schema.json');
    const defs = checkRunSchema.$defs as Record<string, Record<string, unknown>>;
    const decisive = defs.DecisiveVerificationCheckRun;
    const nonDecisive = defs.NonDecisiveVerificationCheckRun;

    expect(requiredFields(verificationCheckRunBase(checkRunSchema))).not.toContain('validation_chain_binding_ref');
    expect(checkRunSchema.oneOf).toEqual([
      { $ref: '#/$defs/DecisiveVerificationCheckRun' },
      { $ref: '#/$defs/NonDecisiveVerificationCheckRun' },
    ]);
    expect(decisive.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: ['check_role', 'validation_chain_binding_ref'],
        properties: expect.objectContaining({ check_role: { type: 'string', const: 'decisive' } }),
      }),
    ]));
    expect(nonDecisive.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          check_role: { type: 'string', enum: ['supporting', 'diagnostic'] },
        }),
      }),
    ]));
    expect(requiredFields(bindingSchema)).toEqual(expect.arrayContaining([
      'production_entry_ref',
      'production_config_ref',
      'production_execution_status_ref',
      'production_steps',
      'input_refs',
      'checker_ref',
      'checker_request_ref',
      'structured_verdict_ref',
      'execution',
    ]));
  });

  it('keeps checker-request and data-file descriptions aligned with runtime ownership', () => {
    const requestSchema = readJson('validation_checker_request_v1.schema.json');
    const manifestSchema = readJson('computation_manifest_v1.schema.json');
    const dependencies = schemaProperties(manifestSchema).dependencies as {
      properties?: Record<string, { description?: string }>;
    };
    const requestDescription = String(requestSchema.description ?? '');
    const dataDescription = String(dependencies.properties?.data_files?.description ?? '');

    expect(requestDescription).toContain('structured-output URI/path targets');
    expect(requestDescription).toContain('outer validation-chain receipt');
    expect(requestDescription).not.toContain('records adjacent production snapshots');
    expect(requestDescription).not.toContain('content-addressed structured-output targets');
    expect(dataDescription).toContain('Workspace-relative data files');
    expect(dataDescription).toContain('Absolute paths and URIs are not accepted');
  });

  it('generates phase-discriminated step snapshots with required provenance refs', () => {
    const snapshotSchema = readJson('step_execution_snapshot_v1.schema.json');
    const defs = snapshotSchema.$defs as Record<string, Record<string, unknown>>;
    const preSpawn = defs.PreSpawnStepExecutionSnapshot;
    const postExit = defs.PostExitStepExecutionSnapshot;
    const generatedSnapshot = fs.readFileSync(
      path.join(generatedDir, 'step-execution-snapshot-v1.ts'),
      'utf-8',
    );

    expect(snapshotSchema.oneOf).toEqual([
      { $ref: '#/$defs/PreSpawnStepExecutionSnapshot' },
      { $ref: '#/$defs/PostExitStepExecutionSnapshot' },
    ]);
    expect(preSpawn.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: ['phase', 'workspace_file_refs'],
        properties: expect.objectContaining({ phase: { type: 'string', const: 'pre_spawn' } }),
      }),
    ]));
    expect(postExit.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: ['phase', 'workspace_file_refs', 'output_refs'],
        properties: expect.objectContaining({ phase: { type: 'string', const: 'post_exit' } }),
      }),
    ]));
    expect(generatedSnapshot).toContain(
      'export type StepExecutionSnapshotV1 =\n  | PreSpawnStepExecutionSnapshot\n  | PostExitStepExecutionSnapshot;',
    );
    expect(generatedSnapshot).toMatch(
      /type PreSpawnStepExecutionSnapshot[\s\S]*workspace_file_refs:\s*\[/u,
    );
    expect(generatedSnapshot).toMatch(
      /type PostExitStepExecutionSnapshot[\s\S]*workspace_file_refs:\s*\[[\s\S]*output_refs:\s*WorkspaceFileSnapshotEntry\[\]/u,
    );
  });

  it('adds optional verification ref hooks to computation and writing-review bridge contracts', () => {
    const computationSchema = readJson('computation_result_v1.schema.json');
    const bridgeSchema = readJson('writing_review_bridge_v1.schema.json');
    const computationRefs = schemaProperties(computationSchema).verification_refs as { properties?: Record<string, unknown> };
    const bridgeRefs = schemaProperties(bridgeSchema).verification_refs as { properties?: Record<string, unknown> };

    expect(requiredFields(computationSchema)).not.toContain('verification_refs');
    expect(requiredFields(bridgeSchema)).not.toContain('verification_refs');
    expect(Object.keys(computationRefs.properties ?? {})).toEqual([
      'subject_refs',
      'check_run_refs',
      'subject_verdict_refs',
      'coverage_refs',
    ]);
    expect(Object.keys(bridgeRefs.properties ?? {})).toEqual([
      'subject_refs',
      'check_run_refs',
      'subject_verdict_refs',
      'coverage_refs',
    ]);
  });

  it('does not reuse reproducibility_report_v1 as the generic verification kernel', () => {
    const verificationSources = [
      'verification_subject_v1.schema.json',
      'verification_check_run_v1.schema.json',
      'verification_subject_verdict_v1.schema.json',
      'verification_coverage_v1.schema.json',
    ].map(fileName => fs.readFileSync(path.join(schemaDir, fileName), 'utf-8'));

    for (const source of verificationSources) {
      expect(source).not.toContain('reproducibility_report_v1');
    }
  });

  it('generates shared bindings and barrel exports for the verification kernel', () => {
    const generatedIndex = fs.readFileSync(path.join(generatedDir, 'index.ts'), 'utf-8');
    const generatedCheckRun = fs.readFileSync(
      path.join(generatedDir, 'verification-check-run-v1.ts'),
      'utf-8',
    );

    expect(fs.existsSync(path.join(generatedDir, 'verification-subject-v1.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'verification-check-run-v1.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'verification-subject-verdict-v1.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'verification-coverage-v1.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'validation-chain-binding-v1.ts'))).toBe(true);
    expect(generatedIndex).toContain('validation-chain-binding-v1.js');
    expect(generatedIndex).toContain('verification-check-run-v1.js');
    expect(generatedIndex).toContain('verification-coverage-v1.js');
    expect(generatedCheckRun).toContain('export type VerificationCheckRunV1 =');
    expect(generatedCheckRun).toContain('DecisiveVerificationCheckRun');
    expect(generatedCheckRun).toMatch(
      /check_role:\s*["']decisive["'];\s*validation_chain_binding_ref:\s*ArtifactRef/u,
    );
    expect(generatedIndex).toContain('verification-subject-v1.js');
    expect(generatedIndex).toContain('verification-subject-verdict-v1.js');
  });
});
