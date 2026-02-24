import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { listHepResources, readHepResource } from '../../src/vnext/resources.js';

describe('vNext M3: Project/Run + hep:// resources', () => {
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

  it('creates project + run, writes manifest/artifacts, and reads via hep:// resources', async () => {
    const projectRes = await handleToolCall('hep_project_create', {
      name: 'Test Project',
      description: 'Local-only project for tests',
    });

    const projectPayload = JSON.parse(projectRes.content[0].text) as {
      project_id: string;
      project_uri: string;
    };

    expect(projectPayload.project_id).toMatch(/^proj_/);
    expect(projectPayload.project_uri).toBe(`hep://projects/${encodeURIComponent(projectPayload.project_id)}`);

    const runRes = await handleToolCall('hep_run_create', {
      project_id: projectPayload.project_id,
      args_snapshot: { a: 1, nested: { b: 'c' } },
    });

    const runPayload = JSON.parse(runRes.content[0].text) as {
      run_id: string;
      manifest_uri: string;
      artifacts: Array<{ name: string; uri: string }>;
    };

    expect(runPayload.run_id).toMatch(/^run_/);
    expect(runPayload.manifest_uri).toBe(`hep://runs/${encodeURIComponent(runPayload.run_id)}/manifest`);
    expect(runPayload.artifacts.map(a => a.name)).toContain('args_snapshot.json');

    const resources = listHepResources().map(r => r.uri);
    expect(resources).toContain('hep://projects');
    expect(resources).toContain('hep://runs');

    const projectsIndex = readHepResource('hep://projects');
    expect('text' in projectsIndex).toBe(true);
    const projectsJson = JSON.parse((projectsIndex as any).text) as {
      projects: Array<{ project_id: string; uri: string }>;
    };
    expect(projectsJson.projects.map(p => p.project_id)).toContain(projectPayload.project_id);

    const runsIndex = readHepResource('hep://runs');
    expect('text' in runsIndex).toBe(true);
    const runsJson = JSON.parse((runsIndex as any).text) as {
      runs: Array<{ run_id: string; uri: string }>;
    };
    expect(runsJson.runs.map(r => r.run_id)).toContain(runPayload.run_id);

    const manifestContent = readHepResource(runPayload.manifest_uri);
    expect('text' in manifestContent).toBe(true);
    const manifest = JSON.parse((manifestContent as any).text) as {
      run_id: string;
      project_id: string;
      args_snapshot?: { name: string; uri: string };
      steps: Array<{ step: string }>;
    };

    expect(manifest.run_id).toBe(runPayload.run_id);
    expect(manifest.project_id).toBe(projectPayload.project_id);
    expect(manifest.steps[0]?.step).toBe('run_create');
    expect(manifest.args_snapshot?.uri).toContain(`/artifact/`);

    const argsArtifactUri = manifest.args_snapshot?.uri;
    expect(argsArtifactUri).toBeTruthy();

    const argsContent = readHepResource(argsArtifactUri!);
    expect('text' in argsContent).toBe(true);
    const argsJson = JSON.parse((argsContent as any).text) as {
      run_id: string;
      project_id: string;
      args_snapshot: unknown;
    };
    expect(argsJson.run_id).toBe(runPayload.run_id);
    expect(argsJson.project_id).toBe(projectPayload.project_id);
    expect(argsJson.args_snapshot).toEqual({ a: 1, nested: { b: 'c' } });
  });
});
