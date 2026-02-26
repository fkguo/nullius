import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { compileRunLatexOrThrow } from '../../src/core/writing/latexCompileGate.js';

describe('M07: LaTeX compile gate (fail-fast toolchain checks)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;
  let originalPathEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;

    originalPathEnv = process.env.PATH;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });

    if (originalPathEnv !== undefined) process.env.PATH = originalPathEnv;
    else delete process.env.PATH;
  });

  it('fails fast when pdflatex is not available in PATH', async () => {
    const projectRes = await handleToolCall('hep_project_create', { name: 'latex gate missing', description: 'm07' });
    const project = JSON.parse(projectRes.content[0].text) as { project_id: string };
    const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
    const run = JSON.parse(runRes.content[0].text) as { run_id: string };

    process.env.PATH = '';

    await expect(
      compileRunLatexOrThrow({
        run_id: run.run_id,
        tex_artifact_name: 'writing_integrated.tex',
        passes: 1,
        run_bibtex: false,
        timeout_ms: 1000,
      })
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: expect.stringMatching(/toolchain not available/i),
    });
  });
});

