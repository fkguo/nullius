import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { readHepResource } from '../../src/core/resources.js';

const LIVE_SMOKE_ENABLED = process.env.HEP_LIVE_SMOKE === '1';
const describeLive = LIVE_SMOKE_ENABLED ? describe : describe.skip;

describeLive('R8 live smoke: INSPIRE corpus (optional)', () => {
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

  it(
    'resolves a small real corpus to recids and writes evidence-first artifacts',
    async () => {
      const projectRes = await handleToolCall('hep_project_create', { name: 'Live INSPIRE smoke', description: 'r8' });
      const project = JSON.parse(projectRes.content[0].text) as { project_id: string };

      const runRes = await handleToolCall('hep_run_create', { project_id: project.project_id });
      const run = JSON.parse(runRes.content[0].text) as { run_id: string };

      const identifiers = ['1238419', '1258603'];
      const res = await handleToolCall('hep_inspire_resolve_identifiers', {
        run_id: run.run_id,
        identifiers,
      });

      expect(res.isError).not.toBe(true);
      const payload = JSON.parse(res.content[0].text) as {
        mapping_uri: string;
        summary: { total: number; matched: number; not_found: number; errors: number };
      };

      expect(payload.summary.total).toBe(2);
      expect(payload.summary.matched).toBe(2);
      expect(payload.summary.not_found).toBe(0);
      expect(payload.summary.errors).toBe(0);

      const mappingText = String((readHepResource(payload.mapping_uri) as any).text);
      const lines = mappingText
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)) as Array<{ input: string; status: string; recid?: string }>;

      const byInput = new Map(lines.map(l => [l.input, l]));
      for (const id of identifiers) {
        expect(byInput.get(id)?.status).toBe('matched');
        expect(byInput.get(id)?.recid).toBe(id);
      }
    },
    30_000
  );
});
