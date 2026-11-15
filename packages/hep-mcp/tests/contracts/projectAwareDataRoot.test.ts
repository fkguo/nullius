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
  let originalDownloadDir: string | undefined;

  beforeEach(() => {
    // project_root is admitted in canonical form, so expected paths are built
    // from the canonical spelling of the temp directory.
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-project-root-')));
    originalHepDataDir = process.env.HEP_DATA_DIR;
    originalPdgDataDir = process.env.PDG_DATA_DIR;
    originalDownloadDir = process.env.HEP_DOWNLOAD_DIR;
    delete process.env.HEP_DATA_DIR;
    delete process.env.PDG_DATA_DIR;
    delete process.env.HEP_DOWNLOAD_DIR;
  });

  afterEach(() => {
    if (originalHepDataDir !== undefined) process.env.HEP_DATA_DIR = originalHepDataDir;
    else delete process.env.HEP_DATA_DIR;
    if (originalPdgDataDir !== undefined) process.env.PDG_DATA_DIR = originalPdgDataDir;
    else delete process.env.PDG_DATA_DIR;
    if (originalDownloadDir !== undefined) process.env.HEP_DOWNLOAD_DIR = originalDownloadDir;
    else delete process.env.HEP_DOWNLOAD_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('prefers explicit nullius project_root over HEP_DATA_DIR for tool calls', async () => {
    const projectRoot = path.join(tmpRoot, 'project');
    const envDataRoot = path.join(tmpRoot, 'env-hep-data');
    fs.mkdirSync(path.join(projectRoot, '.nullius'), { recursive: true });
    process.env.HEP_DATA_DIR = envDataRoot;

    const result = await handleToolCall('hep_health', {
      project_root: projectRoot,
      check_inspire: false,
    });

    expect(result.isError).not.toBe(true);
    const payload = parsePayload(result);
    expect(payload.config.hep_data_dir).toMatchObject({
      path: path.join(projectRoot, 'artifacts', 'hep-mcp'),
      source: 'project_root',
      project_root: projectRoot,
      writable: true,
    });
    expect(payload.config.downloads_dir.writable).toBe(true);
    expect(payload.ok).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'artifacts'))).toBe(false);
    expect(payload.config.hep_data_dir.path).not.toBe(envDataRoot);
  });

  it('reports an existing file in place of the downloads directory as unwritable', async () => {
    const projectRoot = path.join(tmpRoot, 'project');
    const dataRoot = path.join(projectRoot, 'artifacts', 'hep-mcp');
    fs.mkdirSync(path.join(projectRoot, '.nullius'), { recursive: true });
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'downloads'), 'occupied');

    const result = await handleToolCall('hep_health', { project_root: projectRoot, check_inspire: false });
    const payload = parsePayload(result);
    expect(payload.config.hep_data_dir.writable).toBe(true);
    expect(payload.config.downloads_dir.writable).toBe(false);
    expect(payload.ok).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('reports directories below a read-only parent as unwritable', async () => {
    const projectRoot = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(projectRoot, '.nullius'), { recursive: true });
    fs.chmodSync(projectRoot, 0o555);
    try {
      const result = await handleToolCall('hep_health', { project_root: projectRoot, check_inspire: false });
      const payload = parsePayload(result);
      expect(payload.config.hep_data_dir.writable).toBe(false);
      expect(payload.config.downloads_dir.writable).toBe(false);
      expect(payload.ok).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, 'artifacts'))).toBe(false);
    } finally {
      fs.chmodSync(projectRoot, 0o755);
    }
  });

  it('project_root also overrides static colocated directory env vars', async () => {
    const projectRoot = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(projectRoot, '.nullius'), { recursive: true });
    process.env.HEP_DATA_DIR = path.join(tmpRoot, 'env-hep-data');
    process.env.HEP_DOWNLOAD_DIR = path.join(tmpRoot, 'env-downloads');
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

    const result = await handleToolCall('hep_health', { check_inspire: false });

    expect(result.isError).not.toBe(true);
    const payload = parsePayload(result);
    expect(payload.config.hep_data_dir).toMatchObject({ path: envDataRoot, source: 'env' });
    expect(payload.config.hep_data_dir.project_root).toBeUndefined();
  });

  it('rejects non-absolute project_root values before resolving any data directory', async () => {
    const result = await handleToolCall('hep_health', {
      project_root: 'relative/project',
      check_inspire: false,
    });

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error.code).toBe('INVALID_PARAMS');
    expect(payload.error.message).toContain('project_root');
  });

  it('requires project_root to be an initialized nullius project', async () => {
    const projectRoot = path.join(tmpRoot, 'not-initialized');
    fs.mkdirSync(projectRoot, { recursive: true });

    const result = await handleToolCall('hep_health', {
      project_root: projectRoot,
      check_inspire: false,
    });

    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error.code).toBe('INVALID_PARAMS');
    expect(payload.error.data.required_marker).toBe(path.join(projectRoot, '.nullius'));
  });

  it('uses scratch fallback when neither project_root nor HEP_DATA_DIR is set', () => {
    expect(resolveHepDataRoot().path).toBe(path.join(os.homedir(), '.nullius', 'hep-mcp'));
    expect(resolveHepDataRoot().source).toBe('scratch');
    expect(getDataDir()).toBe(path.join(os.homedir(), '.nullius', 'hep-mcp'));
  });

  it('advertises project_root as a common optional MCP tool input', () => {
    const healthTool = getTools('standard').find(tool => tool.name === 'hep_health');
    expect(healthTool?.inputSchema.properties?.project_root).toMatchObject({
      type: 'string',
    });
  });
});
