import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getTools, handleToolCall } from '../../src/tools/index.js';
import { getDataDir, resolveHepDataRoot } from '../../src/data/dataDir.js';

function parsePayload(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

describe('project-aware HEP data root resolution', () => {
  let tmpRoot: string;
  let originalHepDataDir: string | undefined;
  let originalPdgDataDir: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-project-root-'));
    originalHepDataDir = process.env.HEP_DATA_DIR;
    originalPdgDataDir = process.env.PDG_DATA_DIR;
    delete process.env.HEP_DATA_DIR;
    delete process.env.PDG_DATA_DIR;
  });

  afterEach(() => {
    if (originalHepDataDir !== undefined) process.env.HEP_DATA_DIR = originalHepDataDir;
    else delete process.env.HEP_DATA_DIR;
    if (originalPdgDataDir !== undefined) process.env.PDG_DATA_DIR = originalPdgDataDir;
    else delete process.env.PDG_DATA_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('prefers explicit autoresearch project_root over HEP_DATA_DIR for tool calls', async () => {
    const projectRoot = path.join(tmpRoot, 'project');
    const envDataRoot = path.join(tmpRoot, 'env-hep-data');
    fs.mkdirSync(path.join(projectRoot, '.autoresearch'), { recursive: true });
    process.env.HEP_DATA_DIR = envDataRoot;

    const result = await handleToolCall('hep_project_create', {
      project_root: projectRoot,
      name: 'project local HEP root',
    });

    expect(result.isError).not.toBe(true);
    const payload = parsePayload(result);
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'hep-mcp', 'projects', payload.project_id, 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(envDataRoot, 'projects', payload.project_id, 'project.json'))).toBe(false);
  });

  it('project_root also overrides static colocated directory env vars', async () => {
    const projectRoot = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(projectRoot, '.autoresearch'), { recursive: true });
    process.env.HEP_DATA_DIR = path.join(tmpRoot, 'env-hep-data');
    process.env.HEP_DOWNLOAD_DIR = path.join(tmpRoot, 'env-downloads');
    process.env.WRITING_PROGRESS_DIR = path.join(tmpRoot, 'env-writing-progress');
    process.env.PDG_DATA_DIR = path.join(tmpRoot, 'env-pdg');

    const result = await handleToolCall('hep_health', {
      project_root: projectRoot,
      check_inspire: false,
    });

    expect(result.isError).not.toBe(true);
    const payload = parsePayload(result);
    const hepRoot = path.join(projectRoot, 'artifacts', 'hep-mcp');
    expect(payload.config.hep_data_dir.path).toBe(hepRoot);
    expect(payload.config.hep_data_dir.source).toBe('project_root');
    expect(payload.config.downloads_dir.path).toBe(path.join(hepRoot, 'downloads'));
    expect(payload.config.pdg.data_dir).toBe(path.join(hepRoot, 'pdg'));
  });

  it('falls back to HEP_DATA_DIR when project_root is absent', async () => {
    const envDataRoot = path.join(tmpRoot, 'env-hep-data');
    process.env.HEP_DATA_DIR = envDataRoot;

    const result = await handleToolCall('hep_project_create', {
      name: 'env local HEP root',
    });

    expect(result.isError).not.toBe(true);
    const payload = parsePayload(result);
    expect(fs.existsSync(path.join(envDataRoot, 'projects', payload.project_id, 'project.json'))).toBe(true);
  });

  it('rejects non-absolute project_root values before writing data', async () => {
    const result = await handleToolCall('hep_project_create', {
      project_root: 'relative/project',
      name: 'bad root',
    });

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error.code).toBe('INVALID_PARAMS');
    expect(payload.error.message).toContain('project_root');
  });

  it('requires project_root to be an initialized autoresearch project', async () => {
    const projectRoot = path.join(tmpRoot, 'not-initialized');
    fs.mkdirSync(projectRoot, { recursive: true });

    const result = await handleToolCall('hep_project_create', {
      project_root: projectRoot,
      name: 'bad root',
    });

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error.code).toBe('INVALID_PARAMS');
    expect(payload.error.data.required_marker).toBe(path.join(projectRoot, '.autoresearch'));
  });

  it('uses scratch fallback when neither project_root nor HEP_DATA_DIR is set', () => {
    expect(resolveHepDataRoot().path).toBe(path.join(os.homedir(), '.autoresearch', 'hep-mcp'));
    expect(resolveHepDataRoot().source).toBe('scratch');
    expect(getDataDir()).toBe(path.join(os.homedir(), '.autoresearch', 'hep-mcp'));
  });

  it('advertises project_root as a common optional MCP tool input', () => {
    const createTool = getTools('standard').find(tool => tool.name === 'hep_project_create');
    expect(createTool?.inputSchema.properties?.project_root).toMatchObject({
      type: 'string',
    });
  });
});
