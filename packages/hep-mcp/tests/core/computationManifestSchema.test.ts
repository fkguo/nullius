import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');
const schemaPath = path.join(repoRoot, 'meta/schemas/computation_manifest_v1.schema.json');

function readSchema(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>;
}

function sampleManifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    title: 'Muon g-2 light-by-light scan',
    description: 'Evaluate a small symbolic + numeric computation pipeline.',
    entry_point: {
      script: 'mathematica/run_all.wl',
      tool: 'mathematica',
      args: ['--mode', 'scan'],
      env: { LOOPTOOLS_DIR: 'vendor/looptools' },
    },
    steps: [
      {
        id: 'derive',
        tool: 'mathematica',
        script: 'mathematica/derive.wl',
        expected_outputs: ['outputs/derive.json'],
      },
      {
        id: 'scan',
        tool: 'python',
        script: 'python/scan.py',
        depends_on: ['derive'],
        args: ['--input', 'outputs/derive.json'],
        expected_outputs: ['outputs/scan.json'],
        timeout_minutes: 10,
      },
    ],
    environment: {
      mathematica_version: '13.3',
      python_version: '3.11',
      platform: 'macos',
    },
    dependencies: {
      mathematica_packages: ['FeynCalc'],
      python_packages: ['numpy>=1.26'],
      external_libraries: ['LoopTools-2.18'],
    },
    computation_budget: {
      estimated_runtime_minutes: 5,
      max_runtime_minutes: 30,
      max_memory_gb: 4,
      max_cpu_cores: 4,
    },
    outputs: ['outputs/scan.json'],
    created_at: '2026-03-12T00:00:00Z',
  };
}

describe('computation manifest schema (UX-02)', () => {
  it('validates a representative manifest instance and keeps the documented contract surface', () => {
    const schema = readSchema();
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(schema);

    expect(validate(sampleManifest()), JSON.stringify(validate.errors, null, 2)).toBe(true);

    const required = new Set((schema.required as string[]) ?? []);
    expect(required).toEqual(
      new Set(['schema_version', 'entry_point', 'steps', 'environment', 'dependencies']),
    );
    expect((schema.properties as Record<string, unknown>).computation_budget).toBeDefined();
  });

  it('rejects manifests that omit the required execution surface', () => {
    const schema = readSchema();
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    const validate = ajv.compile(schema);
    const invalidManifest = sampleManifest();

    delete invalidManifest.entry_point;
    delete invalidManifest.steps;

    expect(validate(invalidManifest)).toBe(false);
    expect(
      (validate.errors ?? []).some(
        error => error.keyword === 'required' && (error.params as { missingProperty?: string }).missingProperty === 'entry_point',
      ),
    ).toBe(true);
    expect(
      (validate.errors ?? []).some(
        error => error.keyword === 'required' && (error.params as { missingProperty?: string }).missingProperty === 'steps',
      ),
    ).toBe(true);
  });
});
