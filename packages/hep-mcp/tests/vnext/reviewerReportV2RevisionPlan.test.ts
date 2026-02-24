import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRun } from '../../src/vnext/runs.js';
import { getRunArtifactPath } from '../../src/vnext/paths.js';
import { ensureWritingQualityPolicyV1 } from '../../src/vnext/writing/qualityPolicy.js';

const REVIEWER_REPORT_OK = {
  version: 2,
  severity: 'minor',
  summary: 'Looks mostly good.',
  major_issues: [],
  minor_issues: [],
  notation_changes: [],
  asset_pointer_issues: [],
  follow_up_evidence_queries: [],
  structure_issues: [],
  grounding_risks: [],
};

describe('M08: ReviewerReport v2 + RevisionPlan v1', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('accepts ReviewerReport v2-only and writes writing_reviewer_report.json', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'review v2', description: 'm08' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_run_writing_submit_review', {
      run_id: run.run_id,
      round: 1,
      reviewer_report: REVIEWER_REPORT_OK,
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as any;
    expect(payload.manifest_uri).toBe(`hep://runs/${encodeURIComponent(run.run_id)}/manifest`);
    expect((payload.artifacts ?? []).some((a: any) => a.name === 'writing_reviewer_report_round_01.json')).toBe(true);
    expect((payload.artifacts ?? []).some((a: any) => a.name === 'writing_reviewer_report.json')).toBe(true);

    const artifact = JSON.parse(fs.readFileSync(getRunArtifactPath(run.run_id, 'writing_reviewer_report.json'), 'utf-8')) as any;
    expect(artifact.version).toBe(2);
    expect(artifact.reviewer_report?.version).toBe(2);
    expect(artifact.derived?.recommended_resume_from).toBe('review');
  });

  it('rejects v1-shaped reviewer_report and writes parse_error artifact', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'review v1 reject', description: 'm08' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_run_writing_submit_review', {
      run_id: run.run_id,
      round: 1,
      reviewer_report: { severity: 'minor', summary: 'missing v2 fields' },
    });
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(typeof payload.error?.data?.parse_error_uri).toBe('string');
    expect(payload.error?.data?.parse_error_artifact).toBe('writing_parse_error_reviewer_report_v2.json');
    expect(fs.existsSync(getRunArtifactPath(run.run_id, 'writing_parse_error_reviewer_report_v2.json'))).toBe(true);
  });

  it('revision plan prompt_packet → stage → submit writes writing_revision_plan_round_01_v1.json', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'revision plan', description: 'm08' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    ensureWritingQualityPolicyV1({ run_id: run.run_id, quality_level: 'standard' });

    const reviewRes = await handleToolCall('hep_run_writing_submit_review', {
      run_id: run.run_id,
      round: 1,
      reviewer_report: REVIEWER_REPORT_OK,
    });
    expect(reviewRes.isError).not.toBe(true);

    const reviewerReportUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('writing_reviewer_report_round_01.json')}`;
    const manifestUri = `hep://runs/${encodeURIComponent(run.run_id)}/manifest`;

    const packetRes = await handleToolCall('hep_run_writing_create_revision_plan_packet_v1', {
      reviewer_report_uri: reviewerReportUri,
      manifest_uri: manifestUri,
      round: 1,
    });
    expect(packetRes.isError).not.toBe(true);

    const packetPayload = JSON.parse(packetRes.content[0].text) as any;
    expect((packetPayload.artifacts ?? []).some((a: any) => a.name === 'writing_revision_plan_prompt_packet_round_01.json')).toBe(true);

    const plan = {
      version: 1,
      round: 1,
      max_rounds: 2,
      actions: [
        {
          type: 'rewrite_section',
          target_section_index: 1,
          inputs: [reviewerReportUri],
          rewrite_instructions: 'Apply the requested fixes from the reviewer report.',
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

    const submitted = JSON.parse(fs.readFileSync(getRunArtifactPath(run.run_id, 'writing_revision_plan_round_01_v1.json'), 'utf-8')) as any;
    expect(submitted.revision_plan?.version).toBe(1);
    expect(submitted.revision_plan?.round).toBe(1);
    expect(Array.isArray(submitted.revision_plan?.actions)).toBe(true);

    const manifest = getRun(run.run_id);
    expect(manifest.steps.some(s => s.step === 'writing_revise' && s.status === 'done')).toBe(true);
  });

  it('supports round-aware revision plan artifacts (round 02)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'revision plan round2', description: 'm09' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    ensureWritingQualityPolicyV1({ run_id: run.run_id, quality_level: 'standard' });

    await handleToolCall('hep_run_writing_submit_review', {
      run_id: run.run_id,
      round: 2,
      reviewer_report: REVIEWER_REPORT_OK,
    });

    const reviewerReportUri = `hep://runs/${encodeURIComponent(run.run_id)}/artifact/${encodeURIComponent('writing_reviewer_report_round_02.json')}`;
    const manifestUri = `hep://runs/${encodeURIComponent(run.run_id)}/manifest`;

    const packetRes = await handleToolCall('hep_run_writing_create_revision_plan_packet_v1', {
      reviewer_report_uri: reviewerReportUri,
      manifest_uri: manifestUri,
      round: 2,
    });
    expect(packetRes.isError).not.toBe(true);

    const packetPayload = JSON.parse(packetRes.content[0].text) as any;
    expect((packetPayload.artifacts ?? []).some((a: any) => a.name === 'writing_revision_plan_prompt_packet_round_02.json')).toBe(true);

    const plan = {
      version: 1,
      round: 2,
      max_rounds: 2,
      actions: [
        {
          type: 'rewrite_section',
          target_section_index: 1,
          inputs: [reviewerReportUri],
          rewrite_instructions: 'Apply the requested fixes from the reviewer report.',
          expected_verifications: ['citations', 'structure'],
        },
      ],
    };

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: run.run_id,
      content_type: 'revision_plan',
      artifact_suffix: 'round02',
      content: JSON.stringify(plan),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_revision_plan_v1', {
      run_id: run.run_id,
      revision_plan_uri: staged.staging_uri,
    });
    expect(submitRes.isError).not.toBe(true);

    const submitted = JSON.parse(fs.readFileSync(getRunArtifactPath(run.run_id, 'writing_revision_plan_round_02_v1.json'), 'utf-8')) as any;
    expect(submitted.revision_plan?.round).toBe(2);
  });

  it('rejects cross-run URIs in revision_plan.actions[].inputs', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'cross-run revision plan', description: 'm08' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runARes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const runA = JSON.parse(runARes.content[0].text) as { run_id: string };

    const runBRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const runB = JSON.parse(runBRes.content[0].text) as { run_id: string };

    ensureWritingQualityPolicyV1({ run_id: runB.run_id, quality_level: 'standard' });

    await handleToolCall('hep_run_writing_submit_review', { run_id: runB.run_id, round: 1, reviewer_report: REVIEWER_REPORT_OK });

    const reviewerReportUriB = `hep://runs/${encodeURIComponent(runB.run_id)}/artifact/${encodeURIComponent('writing_reviewer_report_round_01.json')}`;
    const manifestUriB = `hep://runs/${encodeURIComponent(runB.run_id)}/manifest`;
    const packetRes = await handleToolCall('hep_run_writing_create_revision_plan_packet_v1', {
      reviewer_report_uri: reviewerReportUriB,
      manifest_uri: manifestUriB,
      round: 1,
    });
    expect(packetRes.isError).not.toBe(true);

    const crossRunPlan = {
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
    };

    const stageRes = await handleToolCall('hep_run_stage_content', {
      run_id: runB.run_id,
      content_type: 'revision_plan',
      artifact_suffix: 'cross',
      content: JSON.stringify(crossRunPlan),
    });
    expect(stageRes.isError).not.toBe(true);
    const staged = JSON.parse(stageRes.content[0].text) as { staging_uri: string };

    const submitRes = await handleToolCall('hep_run_writing_submit_revision_plan_v1', {
      run_id: runB.run_id,
      revision_plan_uri: staged.staging_uri,
    });
    expect(submitRes.isError).toBe(true);

    const payload = JSON.parse(submitRes.content[0].text) as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
  });
});
