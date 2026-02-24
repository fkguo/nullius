import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readEvalFixture } from './evalSnapshots.js';

const { handleToolCall } = await import('../../src/tools/index.js');

describe('eval: verifier failure cases (local-only)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('fails hard on missing citations for grounded fact sentences', async () => {
    const draft = readEvalFixture<any>('draft_missing_citation.json');

    const projectRes = await handleToolCall('hep_project_create', { name: 'Eval Project', description: 'eval-verifier' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    const res = await handleToolCall('hep_render_latex', {
      run_id: run.run_id,
      draft,
      allowed_citations: [],
    });

    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text) as any;
    expect(payload?.error?.message).toContain('Citation verification failed');
    expect(payload?.error?.data?.issues?.length ?? 0).toBeGreaterThan(0);
  });
});
