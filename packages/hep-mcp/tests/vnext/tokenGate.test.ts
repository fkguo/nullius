import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRunArtifactPath } from '../../src/vnext/paths.js';

function parseToolJson(res: { content: Array<{ type: string; text: string }>; isError?: boolean }): any {
  return JSON.parse(res.content[0]?.text ?? '{}');
}

describe('M05 TokenBudgetPlan + TokenGate (run tools)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-mcp-token-gate-'));
    process.env.HEP_DATA_DIR = tempDir;
  });

  afterEach(() => {
    delete process.env.HEP_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates token budget plan and gates pass/overflow with artifacts', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'proj', description: 'test' }, 'standard');
    const project = parseToolJson(projectRes);
    const projectId = project.project_id as string;

    const runRes = await handleToolCall('hep_run_create', { project_id: projectId }, 'standard');
    const run = parseToolJson(runRes);
    const runId = run.run_id as string;

    const planRes = await handleToolCall(
      'hep_run_writing_create_token_budget_plan_v1',
      { run_id: runId, model_context_tokens: 32_000 },
      'standard'
    );
    expect(planRes.isError).toBeFalsy();
    const plan = parseToolJson(planRes);
    expect(String(plan.summary?.token_budget_plan_uri ?? '')).toContain('writing_token_budget_plan_v1.json');
    expect(fs.existsSync(getRunArtifactPath(runId, 'writing_token_budget_plan_v1.json'))).toBe(true);

    const promptPacket = {
      schema_name: 'demo_prompt',
      schema_version: 1,
      expected_output_format: 'markdown',
      system_prompt: 'System.',
      user_prompt: 'User.',
      context_uris: [],
    };

    const passRes = await handleToolCall(
      'hep_run_writing_token_gate_v1',
      {
        run_id: runId,
        step: 'outline',
        prompt_packet: promptPacket,
      },
      'standard'
    );
    expect(passRes.isError).toBeFalsy();
    const pass = parseToolJson(passRes);
    expect(pass.summary?.gate).toBe('pass');
    expect(String(pass.summary?.token_gate_pass_uri ?? '')).toContain('token_gate_pass_outline_v1.json');
    expect(fs.existsSync(getRunArtifactPath(runId, 'token_gate_pass_outline_v1.json'))).toBe(true);

    const overflowRes = await handleToolCall(
      'hep_run_writing_token_gate_v1',
      {
        run_id: runId,
        step: 'outline',
        max_context_tokens: 4096,
        prompt_packet: {
          ...promptPacket,
          user_prompt: 'X'.repeat(8000),
        },
      },
      'standard'
    );
    expect(overflowRes.isError).toBeTruthy();
    const overflow = parseToolJson(overflowRes);
    expect(overflow.error?.code).toBe('INVALID_PARAMS');
    expect(String(overflow.error?.message ?? '')).toContain('exceeds token budget by');
    expect(String(overflow.error?.message ?? '')).toContain('See overflow artifact at hep://');
    expect(Number(overflow.error?.data?.overflow_tokens ?? 0)).toBeGreaterThan(0);
    expect(String(overflow.error?.data?.token_overflow_uri ?? '')).toContain('writing_token_overflow_outline_v1.json');
    expect(Array.isArray(overflow.error?.data?.next_actions)).toBe(true);
    expect(fs.existsSync(getRunArtifactPath(runId, 'writing_token_overflow_outline_v1.json'))).toBe(true);
  });

  it('rejects cross-run evidence_packet_uri', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'proj', description: 'test' }, 'standard');
    const project = parseToolJson(projectRes);
    const projectId = project.project_id as string;

    const runRes1 = await handleToolCall('hep_run_create', { project_id: projectId }, 'standard');
    const run1 = parseToolJson(runRes1);
    const runId1 = run1.run_id as string;

    const runRes2 = await handleToolCall('hep_run_create', { project_id: projectId }, 'standard');
    const run2 = parseToolJson(runRes2);
    const runId2 = run2.run_id as string;

    const planRes = await handleToolCall(
      'hep_run_writing_create_token_budget_plan_v1',
      { run_id: runId1, model_context_tokens: 32_000 },
      'standard'
    );
    expect(planRes.isError).toBeFalsy();

    const otherArtifactName = 'dummy_evidence_packet.json';
    fs.writeFileSync(getRunArtifactPath(runId2, otherArtifactName), JSON.stringify({ candidates: [] }, null, 2), 'utf-8');

    const crossRunUri = `hep://runs/${encodeURIComponent(runId2)}/artifact/${encodeURIComponent(otherArtifactName)}`;

    const promptPacket = {
      schema_name: 'demo_prompt',
      schema_version: 1,
      expected_output_format: 'markdown',
      system_prompt: 'System.',
      user_prompt: 'User.',
      context_uris: [],
    };

    const crossRes = await handleToolCall(
      'hep_run_writing_token_gate_v1',
      {
        run_id: runId1,
        step: 'outline',
        prompt_packet: promptPacket,
        evidence_packet_uri: crossRunUri,
      },
      'standard'
    );
    expect(crossRes.isError).toBeTruthy();
    const cross = parseToolJson(crossRes);
    expect(cross.error?.code).toBe('INVALID_PARAMS');
    expect(String(cross.error?.message ?? '')).toContain('Cross-run artifact reference is not allowed');
  });
});
