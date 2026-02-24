import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { getRunArtifactPath } from '../../src/vnext/paths.js';

describe('M11: hep_run_writing_integrate_sections_v1 artifact contracts', () => {
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

  it('fails fast when writing_section_###.json is missing (includes next_actions)', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'integrate missing section', description: 'm11' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    fs.writeFileSync(
      getRunArtifactPath(run.run_id, 'writing_packets_sections.json'),
      JSON.stringify(
        {
          version: 1,
          run_id: run.run_id,
          target_length: 'short',
          sections: [
            {
              index: 1,
              section_number: '1',
              section_title: 'Intro',
              packet: {},
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const res = await handleToolCall('hep_run_writing_integrate_sections_v1', { run_id: run.run_id });
    expect(res.isError).toBe(true);

    const payload = JSON.parse(res.content[0]?.text ?? '{}') as any;
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(payload.error?.data?.artifact_name).toBe('writing_section_001.json');

    const tools = (payload.error?.data?.next_actions ?? []).map((a: any) => a.tool);
    expect(tools).toContain('hep_run_writing_create_section_candidates_packet_v1');
  });
});
