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

describe('verification kernel schema foundation', () => {
  it('keeps stable generic subject kinds while leaving check kinds open-ended', () => {
    const subjectSchema = readJson('verification_subject_v1.schema.json');
    const checkRunSchema = readJson('verification_check_run_v1.schema.json');
    const subjectKind = schemaProperties(subjectSchema).subject_kind as { enum?: string[] };
    const checkKind = schemaProperties(checkRunSchema).check_kind as { type?: string; enum?: string[] };

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
    const props = schemaProperties(checkRunSchema);
    const subjectRef = props.subject_ref as { $ref?: string };
    const evidenceRefs = props.evidence_refs as { minItems?: number; items?: { $ref?: string } };

    expect(requiredFields(checkRunSchema)).toContain('subject_ref');
    expect(requiredFields(checkRunSchema)).toContain('evidence_refs');
    expect(subjectRef.$ref).toBe('https://autoresearch.dev/schemas/artifact_ref_v1.schema.json');
    expect(evidenceRefs.minItems).toBe(1);
    expect(evidenceRefs.items?.$ref).toBe('https://autoresearch.dev/schemas/artifact_ref_v1.schema.json');
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

    expect(fs.existsSync(path.join(generatedDir, 'verification-subject-v1.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'verification-check-run-v1.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'verification-subject-verdict-v1.ts'))).toBe(true);
    expect(fs.existsSync(path.join(generatedDir, 'verification-coverage-v1.ts'))).toBe(true);
    expect(generatedIndex).toContain('verification-check-run-v1.js');
    expect(generatedIndex).toContain('verification-coverage-v1.js');
    expect(generatedIndex).toContain('verification-subject-v1.js');
    expect(generatedIndex).toContain('verification-subject-verdict-v1.js');
  });
});
