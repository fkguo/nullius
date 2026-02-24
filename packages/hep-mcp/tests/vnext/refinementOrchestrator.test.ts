import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRunArtifactPath } from '../../src/vnext/paths.js';
import { ensureWritingQualityPolicyV1 } from '../../src/vnext/writing/qualityPolicy.js';

const REVIEWER_REPORT_OK = {
  version: 2,
  severity: 'minor',
  summary: 'Needs a small revision.',
  major_issues: [],
  minor_issues: [],
  notation_changes: [],
  asset_pointer_issues: [],
  follow_up_evidence_queries: [],
  structure_issues: [],
  grounding_risks: [],
};

describe('M09: refinement orchestrator (minimal closed loop)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('fails fast when reviewer_report is missing and writes reviewer prompt/context artifacts', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm09 orchestrator', description: 'm09' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    ensureWritingQualityPolicyV1({ run_id: run.run_id, quality_level: 'standard' });

    const res = await handleToolCall('hep_run_writing_refinement_orchestrator_v1', { run_id: run.run_id, round: 1 });
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.round).toBe(1);
    expect(Array.isArray(payload.error?.data?.next_actions)).toBe(true);

    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_reviewer_prompt_round_01.md'))).toBe(true);
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_reviewer_context_round_01.md'))).toBe(true);
  });

  it('with reviewer_report + revision_plan present, returns next_actions for at least one action', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm09 loop', description: 'm09' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    ensureWritingQualityPolicyV1({ run_id: run.run_id, quality_level: 'standard' });

    // Submit review (round 01).
    const reviewRes = await handleToolCall('hep_run_writing_submit_review', {
      run_id: run.run_id,
      round: 1,
      reviewer_report: REVIEWER_REPORT_OK,
    });
    expect(reviewRes.isError).not.toBe(true);

    const reviewerReportUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('writing_reviewer_report_round_01.json')}`;
    const manifestUri = `hep://runs/${encodeURIComponent(run.run_id)}/manifest`;

    // Create plan prompt_packet then submit a RevisionPlanV1 with one rewrite_section action.
    const packetRes = await handleToolCall('hep_run_writing_create_revision_plan_packet_v1', {
      reviewer_report_uri: reviewerReportUri,
      manifest_uri: manifestUri,
      round: 1,
    });
    expect(packetRes.isError).not.toBe(true);

    const plan = {
      version: 1,
      round: 1,
      max_rounds: 1,
      actions: [
        {
          type: 'rewrite_section',
          target_section_index: 1,
          inputs: [reviewerReportUri],
          rewrite_instructions: 'Tighten the intro and add one concrete example.',
          expected_verifications: ['citations', 'structure'],
        },
      ],
    };

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'revision_plan',
      artifact_suffix: 'round01',
      content: JSON.stringify(plan),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_revision_plan_v1', {
      run_id: run.run_id,
      revision_plan_uri: staged.staging_uri,
    });
    expect(submitRes.isError).not.toBe(true);

    const orchRes = await handleToolCall('hep_run_writing_refinement_orchestrator_v1', { run_id: run.run_id, round: 1 });
    expect(orchRes.isError).not.toBe(true);

    const orchPayload = JSON.parse(orchRes.content[0].text) as any;
    expect(Array.isArray(orchPayload.next_actions)).toBe(true);
    expect(orchPayload.next_actions[0]?.tool).toBe('hep_run_writing_create_section_write_packet_v1');
    expect(orchPayload.next_actions[0]?.args?.run_id).toBe(run.run_id);
    expect(orchPayload.next_actions[0]?.args?.section_index).toBe(1);
  });

  it('writes parse_error artifact when revision plan JSON is malformed', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm09 parse error', description: 'm09' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    ensureWritingQualityPolicyV1({ run_id: run.run_id, quality_level: 'standard' });

    await handleToolCall('hep_run_writing_submit_review', {
      run_id: run.run_id,
      round: 1,
      reviewer_report: REVIEWER_REPORT_OK,
    });

    // Malformed JSON in the canonical revision plan artifact path.
    fs.writeFileSync(getRunArtifactPath(run.run_id, 'writing_revision_plan_round_01_v1.json'), '{not-json', 'utf-8');

    const res = await handleToolCall('hep_run_writing_refinement_orchestrator_v1', { run_id: run.run_id, round: 1 });
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.parse_error_artifact).toBe('writing_parse_error_revision_plan_v1_round_01.json');
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_parse_error_revision_plan_v1_round_01.json'))).toBe(true);
  });

  it('rejects cross-run inputs in revision plan (defense-in-depth)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'm09 cross-run', description: 'm09' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runARes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const runA = JSON.parse(runARes.content[0].text) as { run_id: string };

    const runBRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const runB = JSON.parse(runBRes.content[0].text) as { run_id: string };

    ensureWritingQualityPolicyV1({ run_id: runB.run_id, quality_level: 'standard' });
    await handleToolCall('hep_run_writing_submit_review', { run_id: runB.run_id, round: 1, reviewer_report: REVIEWER_REPORT_OK });

    const crossRunPlanArtifact = {
      version: 1,
      generated_at: new Date().toISOString(),
      run_id: runB.run_id,
      project_id: project.project_id,
      request: { round: 1 },
      revision_plan: {
        version: 1,
        round: 1,
        max_rounds: 1,
        actions: [
          {
            type: 'rewrite_section',
            target_section_index: 1,
            inputs: [`hep://runs/${encodeURIComponent(runA.run_id)}/artifact/${encodeURIComponent('args_snapshot.json')}`],
            rewrite_instructions: 'Rewrite section to remove cross-run dependency.',
            expected_verifications: ['citations', 'structure'],
          },
        ],
      },
      derived: { actions_total: 1, action_types: { rewrite_section: 1 } },
    };

    fs.writeFileSync(
      getRunArtifactPath(runB.run_id, 'writing_revision_plan_round_01_v1.json'),
      JSON.stringify(crossRunPlanArtifact, null, 2),
      'utf-8'
    );

    const res = await handleToolCall('hep_run_writing_refinement_orchestrator_v1', { run_id: runB.run_id, round: 1 });
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(String(payload.error?.message ?? '')).toMatch(/Cross-run input URI/i);
  });
});
