import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRunArtifactPath } from '../../src/core/paths.js';

describe('M06: hep_run_writing_create_section_write_packet_v1', () => {
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

  it('creates section write packet + evidence context + prompt text artifacts (TokenGate-gated)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M06 section write packet', description: 'm06' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_claims_table.json'),
      JSON.stringify({ claims_table: { corpus_snapshot: { recids: ['123'] }, claims: [] } }, null, 2),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_outline_v2.json'),
      JSON.stringify(
        {
          version: 2,
          generated_at: '2026-01-12T00:00:00Z',
          run_id: run.run_id,
          project_id: project.project_id,
          request: { target_length: 'medium' },
          outline_plan: {
            language: 'en',
            title: 'Demo Title',
            sections: [
              {
                number: '1',
                title: 'Introduction',
                type: 'introduction',
                suggested_word_count: 200,
                key_points: ['Motivation'],
                assigned_claim_ids: ['c1'],
                blueprint: {
                  purpose: 'Set context',
                  key_questions: ['What is the context?'],
                  dependencies: { requires_sections: [], defines_terms: [], uses_terms: [] },
                  anti_overlap: { must_not_overlap_with_sections: [], avoid_topics: [] },
                },
              },
            ],
            cross_ref_map: { defines: [], uses: [] },
            global_narrative: { main_thread: 'Demo thread' },
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_paperset_v1.json'),
      JSON.stringify(
        {
          version: 1,
          generated_at: '2026-01-12T00:00:00Z',
          run_id: run.run_id,
          project_id: project.project_id,
          request: { title: 'Demo Title', topic: 'Demo Topic', target_length: 'medium', language: 'en' },
          paperset: { language: 'en', selected_papers: [] },
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_evidence_packet_section_001_v2.json'),
      JSON.stringify(
        {
          version: 2,
          generated_at: '2026-01-12T00:00:00Z',
          run_id: run.run_id,
          project_id: project.project_id,
          section: { index: 1, title: 'Introduction', section_type: 'introduction' },
          allowed: { claim_ids: ['c1'], chunk_ids: ['chunk_1'], paper_ids: ['inspire:123'] },
          budgets: { overflow_policy: 'fail_fast' },
          chunks: [
            {
              id: 'chunk_1',
              type: 'text',
              text: 'Evidence text about the demo topic.',
              locator: { paper_id: 'inspire:123', section_path: ['intro'] },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const budgetRes = await handleToolCall('hep_run_writing_create_token_budget_plan_v1', {
      run_id: run.run_id,
      model_context_tokens: 32_000,
    });
    expect(budgetRes.isError).not.toBe(true);

    const res = await handleToolCall('hep_run_writing_create_section_write_packet_v1', {
      run_id: run.run_id,
      section_index: 1,
    });
    expect(res.isError).not.toBe(true);

    const payload = JSON.parse(res.content[0].text) as any;
    const names = (payload.artifacts as Array<{ name: string }>).map(a => a.name).sort();
    expect(names).toContain('writing_section_write_packet_section_001_v1.json');
    expect(names).toContain('writing_section_evidence_context_section_001_v1.md');
    expect(names).toContain('writing_section_prompt_section_001_v1.txt');
    expect(names.some((n: string) => n.startsWith('token_gate_pass_section_write_section_001_v1'))).toBe(true);

    const packetPath = getRunArtifactPath(run.run_id, 'writing_section_write_packet_section_001_v1.json');
    expect(fs.existsSync(packetPath)).toBe(true);
    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf-8')) as any;
    expect(packet?.section?.number).toBe('1');
    expect(packet?.evidence?.allowed_paper_ids).toEqual(['inspire:123']);
    expect(typeof packet?.prompt_text_uri).toBe('string');
    expect(Array.isArray(packet?.next_actions)).toBe(true);
  });

  it('fails fast when writing_outline_v2.json is missing (includes next_actions)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M06 missing outline', description: 'm06' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_run_writing_create_section_write_packet_v1', { run_id: run.run_id, section_index: 1 });
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.artifact_name).toBe('writing_outline_v2.json');

    const tools = (payload.error?.data?.next_actions ?? []).map((a: any) => a.tool);
    expect(tools).toContain('hep_run_writing_create_outline_candidates_packet_v1');
  });

  it('fails fast when writing_evidence_packet_section_###_v2.json is missing (includes next_actions)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'M06 missing evidence packet', description: 'm06' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_claims_table.json'),
      JSON.stringify({ claims_table: { corpus_snapshot: { recids: ['123'] }, claims: [] } }, null, 2),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_outline_v2.json'),
      JSON.stringify(
        {
          version: 2,
          generated_at: '2026-01-12T00:00:00Z',
          run_id: run.run_id,
          project_id: project.project_id,
          request: { target_length: 'medium' },
          outline_plan: {
            language: 'en',
            title: 'Demo Title',
            sections: [
              {
                number: '1',
                title: 'Introduction',
                type: 'introduction',
                suggested_word_count: 200,
                key_points: ['Motivation'],
                assigned_claim_ids: ['c1'],
                blueprint: {
                  purpose: 'Set context',
                  key_questions: ['What is the context?'],
                  dependencies: { requires_sections: [], defines_terms: [], uses_terms: [] },
                  anti_overlap: { must_not_overlap_with_sections: [], avoid_topics: [] },
                },
              },
            ],
            cross_ref_map: { defines: [], uses: [] },
            global_narrative: { main_thread: 'Demo thread' },
          },
        },
        null,
        2
      ),
      'utf-8'
    );

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_paperset_v1.json'),
      JSON.stringify(
        {
          version: 1,
          generated_at: '2026-01-12T00:00:00Z',
          run_id: run.run_id,
          project_id: project.project_id,
          request: { title: 'Demo Title', topic: 'Demo Topic', target_length: 'medium', language: 'en' },
          paperset: { language: 'en', selected_papers: [] },
        },
        null,
        2
      ),
      'utf-8'
    );

    const res = await handleToolCall('hep_run_writing_create_section_write_packet_v1', { run_id: run.run_id, section_index: 1 });
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.artifact_name).toBe('writing_evidence_packet_section_001_v2.json');

    const tools = (payload.error?.data?.next_actions ?? []).map((a: any) => a.tool);
    expect(tools).toContain('hep_run_writing_build_evidence_packet_section_v2');
  });
});
