import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ingestSkillArtifacts } from '../../src/tools/ingest-skill-artifacts.js';

describe('ingestSkillArtifacts', () => {
  let tmpDir: string;
  let runId: string;
  let runDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-ingest-test-'));
    // Set HEP_DATA_DIR so getRunDir works
    process.env.HEP_DATA_DIR = tmpDir;

    // Create a run directory with a manifest
    runId = 'test-run-001';
    runDir = path.join(tmpDir, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });

    // Minimal manifest
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
      run_id: runId,
      project_id: 'test-project',
      status: 'running',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      steps: [],
    }));

    // Create skill artifacts dir
    const skillDir = path.join(runDir, 'skill-output');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'result.json'), JSON.stringify({ value: 42 }));
    fs.writeFileSync(path.join(skillDir, 'log.txt'), 'computation log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HEP_DATA_DIR;
  });

  it('writes JSONL catalog entry with correct fields', async () => {
    const result = await ingestSkillArtifacts({
      run_id: runId,
      skill_artifacts_dir: path.join(runDir, 'skill-output'),
      tags: ['feyncalc', 'one-loop'],
    });

    expect(result.ok).toBe(true);
    expect(result.artifact_count).toBe(2);
    expect(result.catalog_entry_id).toMatch(/^comp_ev_[0-9a-f]{12}$/);
    expect(result.ingested_at).toBeTruthy();

    // Verify JSONL file
    const catalogPath = path.join(runDir, 'computation_evidence_catalog_v1.jsonl');
    expect(fs.existsSync(catalogPath)).toBe(true);
    const lines = fs.readFileSync(catalogPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry.schema_version).toBe(1);
    expect(entry.run_id).toBe(runId);
    expect(entry.skill_id).toBe('skill-output');
    expect(entry.artifacts.length).toBe(2);
    expect(entry.tags).toEqual(['feyncalc', 'one-loop']);
    for (const a of entry.artifacts) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.path).toBeTruthy();
    }
  });

  it('rejects when dir is outside run_dir (C-02)', async () => {
    await expect(
      ingestSkillArtifacts({
        run_id: runId,
        skill_artifacts_dir: '/tmp/evil',
      }),
    ).rejects.toThrow('must be within');
  });

  it('rejects when dir is empty', async () => {
    const emptyDir = path.join(runDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    await expect(
      ingestSkillArtifacts({
        run_id: runId,
        skill_artifacts_dir: emptyDir,
      }),
    ).rejects.toThrow('contains no files');
  });

  it('appends multiple entries to JSONL', async () => {
    const skillDir = path.join(runDir, 'skill-output');

    await ingestSkillArtifacts({ run_id: runId, skill_artifacts_dir: skillDir });
    await ingestSkillArtifacts({ run_id: runId, skill_artifacts_dir: skillDir });

    const catalogPath = path.join(runDir, 'computation_evidence_catalog_v1.jsonl');
    const lines = fs.readFileSync(catalogPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });

  it('computes manifest SHA-256 when manifest_path provided', async () => {
    const manifestPath = path.join(runDir, 'computation_manifest_v1.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1 }));

    const result = await ingestSkillArtifacts({
      run_id: runId,
      skill_artifacts_dir: path.join(runDir, 'skill-output'),
      manifest_path: manifestPath,
    });

    expect(result.ok).toBe(true);

    const catalogPath = path.join(runDir, 'computation_evidence_catalog_v1.jsonl');
    const entry = JSON.parse(fs.readFileSync(catalogPath, 'utf-8').split('\n')[0]!);
    expect(entry.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('discovers files in subdirectories (recursive walk)', async () => {
    const skillDir = path.join(runDir, 'nested-skill');
    fs.mkdirSync(path.join(skillDir, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'top.txt'), 'top-level');
    fs.writeFileSync(path.join(skillDir, 'subdir', 'deep.txt'), 'nested');

    const result = await ingestSkillArtifacts({
      run_id: runId,
      skill_artifacts_dir: skillDir,
    });

    expect(result.ok).toBe(true);
    expect(result.artifact_count).toBe(2);

    const catalogPath = path.join(runDir, 'computation_evidence_catalog_v1.jsonl');
    const entry = JSON.parse(fs.readFileSync(catalogPath, 'utf-8').split('\n').filter(Boolean).pop()!);
    const paths = entry.artifacts.map((a: { path: string }) => a.path);
    expect(paths).toContainEqual(expect.stringContaining('subdir/deep.txt'));
    expect(paths).toContainEqual(expect.stringContaining('top.txt'));
  });

  it('passes through caller-provided step_id', async () => {
    const customStepId = 'my-semantic-step-name';
    const result = await ingestSkillArtifacts({
      run_id: runId,
      skill_artifacts_dir: path.join(runDir, 'skill-output'),
      step_id: customStepId,
    });

    expect(result.ok).toBe(true);

    const catalogPath = path.join(runDir, 'computation_evidence_catalog_v1.jsonl');
    const entry = JSON.parse(fs.readFileSync(catalogPath, 'utf-8').split('\n')[0]!);
    expect(entry.step_id).toBe(customStepId);
  });
});
