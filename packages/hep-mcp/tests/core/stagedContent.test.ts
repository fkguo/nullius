import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/core/projects.js';
import { createRun } from '../../src/core/runs.js';
import { getRunArtifactPath } from '../../src/core/paths.js';
import { readStagedContent, stageRunContent } from '../../src/core/writing/staging.js';

describe('HEP staged content adapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-staged-content-'));
    process.env.HEP_DATA_DIR = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'runs'), { recursive: true });
  });

  afterEach(() => {
    delete process.env.HEP_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a hep:// staging uri while delegating artifact creation to the generic staging kernel', async () => {
    const project = createProject({ name: 'stage-content-project' });
    const run = createRun({ project_id: project.project_id });

    const staged = await stageRunContent({
      run_id: run.manifest.run_id,
      content_type: 'section_output',
      content: '{"section_number":"1","title":"Draft","content":"Hello"}',
      artifact_suffix: 'fixture',
      task_id: 'task-draft-1',
      task_kind: 'draft_update',
    });

    expect(staged.artifact_name).toBe('staged_section_output_fixture.json');
    expect(staged.staging_uri).toBe(
      `hep://runs/${encodeURIComponent(run.manifest.run_id)}/artifact/staged_section_output_fixture.json`,
    );
    const rawArtifact = JSON.parse(
      fs.readFileSync(getRunArtifactPath(run.manifest.run_id, 'staged_section_output_fixture.json'), 'utf-8'),
    ) as { task_ref?: { task_id?: string; task_kind?: string } };
    expect(rawArtifact.task_ref).toEqual({
      task_id: 'task-draft-1',
      task_kind: 'draft_update',
    });

    const parsed = await readStagedContent(run.manifest.run_id, staged.staging_uri, 'section_output') as {
      section_number: string;
      title: string;
      content: string;
    };
    expect(parsed.title).toBe('Draft');
    expect(parsed.content).toBe('Hello');
  });

  it('allows delegated review adapters to stage task-scoped judge_decision content', async () => {
    const project = createProject({ name: 'stage-content-review-project' });
    const run = createRun({ project_id: project.project_id });

    const staged = await stageRunContent({
      run_id: run.manifest.run_id,
      content_type: 'judge_decision',
      content: '{"schema_version":1,"disposition":"accept","reason":"ok"}',
      artifact_suffix: 'review',
      task_id: 'task-review-1',
      task_kind: 'review',
    });

    expect(staged.artifact_name).toBe('staged_judge_decision_review.json');
    const rawArtifact = JSON.parse(
      fs.readFileSync(getRunArtifactPath(run.manifest.run_id, 'staged_judge_decision_review.json'), 'utf-8'),
    ) as { task_ref?: { task_id?: string; task_kind?: string }; content_type?: string };
    expect(rawArtifact.content_type).toBe('judge_decision');
    expect(rawArtifact.task_ref).toEqual({
      task_id: 'task-review-1',
      task_kind: 'review',
    });
  });

  it('fails closed on cross-run staged content references', async () => {
    const project = createProject({ name: 'cross-run-project' });
    const runA = createRun({ project_id: project.project_id });
    const runB = createRun({ project_id: project.project_id });
    const staged = await stageRunContent({
      run_id: runA.manifest.run_id,
      content_type: 'section_output',
      content: '{"title":"A"}',
      artifact_suffix: 'cross-run',
    });

    await expect(
      readStagedContent(runB.manifest.run_id, staged.staging_uri, 'section_output'),
    ).rejects.toThrow(/Cross-run staging reference is not allowed/);
  });

  it('fails closed on malformed staged artifact shape', async () => {
    const project = createProject({ name: 'malformed-stage-project' });
    const run = createRun({ project_id: project.project_id });
    const staged = await stageRunContent({
      run_id: run.manifest.run_id,
      content_type: 'reviewer_report',
      content: '{"summary":"ok"}',
      artifact_suffix: 'broken',
    });

    fs.writeFileSync(
      getRunArtifactPath(run.manifest.run_id, 'staged_reviewer_report_broken.json'),
      JSON.stringify({
        version: 2,
        staged_at: '2026-04-13T00:00:00Z',
        content_type: 'reviewer_report',
        content: '{"summary":"broken"}',
      }, null, 2),
      'utf-8',
    );

    await expect(
      readStagedContent(run.manifest.run_id, staged.staging_uri, 'reviewer_report'),
    ).rejects.toThrow(/Unsupported staged artifact shape/);
  });
});
