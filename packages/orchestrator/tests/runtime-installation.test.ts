import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { installedRuntimeRoot, resolveRuntimeLaunch } from '../src/cli-runtime.js';
import { runCli } from '../src/cli.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const parent = fs.mkdtempSync(path.join(tmpdir(), 'nullius-runtime-'));
  roots.push(parent);
  const workspace = path.join(parent, 'installation');
  const project = path.join(parent, 'research');
  const home = path.join(parent, 'home');
  fs.mkdirSync(path.join(workspace, 'packages/skills-market'), { recursive: true });
  fs.mkdirSync(project);
  fs.mkdirSync(home);
  const registry = {
    'provider-mcp': { entrypoint: 'server.mjs', project_root: 'optional', required_directories: [] },
    'project-mcp': { entrypoint: 'server.mjs', project_root: 'required', required_directories: ['STORE_DIR'] },
  };
  fs.writeFileSync(path.join(workspace, 'server.mjs'), '');
  const registryPath = path.join(workspace, 'packages/skills-market/runtime-servers.json');
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const configPath = path.join(home, 'runtime.json');
  const env = { HOME: home, XDG_CONFIG_HOME: home };
  return { parent, workspace: fs.realpathSync(workspace), project: fs.realpathSync(project), home, registry, registryPath, configPath, env };
}

describe('portable installed runtime', () => {
  it('starts the compiled CLI through the documented symlink installation', () => {
    const f = fixture();
    const link = path.join(f.home, 'nullius');
    fs.symlinkSync(path.join(installedRuntimeRoot(), 'packages/orchestrator/dist/cli.js'), link);
    for (const args of [['--help'], ['runtime', 'path']]) {
      const child = spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', timeout: 5000 });
      expect(child.status).toBe(0);
      expect(child.stderr).toBe('');
      expect(child.stdout).toContain(args[0] === '--help' ? 'nullius runtime' : installedRuntimeRoot());
    }
  });

  it('locates the running CLI, independently of cwd and stale provenance variables', async () => {
    const f = fixture();
    let output = '';
    const code = await runCli(['runtime', 'path'], { cwd: f.project, stdout: text => { output += text; }, stderr: () => {} });
    expect(code).toBe(0);
    expect(output).toBe(`${installedRuntimeRoot()}\n`);
    expect(fs.existsSync(path.join(output.trim(), 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('permits an unbound provider and resolves current entrypoints after moving an installation', () => {
    const f = fixture();
    const moved = path.join(f.parent, 'different installation');
    fs.renameSync(f.workspace, moved);
    const launch = resolveRuntimeLaunch('provider-mcp', { ...f.env, NULLIUS_WORKSPACE_ROOT: f.workspace }, moved);
    expect(launch.entrypoint).toBe(path.join(fs.realpathSync(moved), 'server.mjs'));
    expect(launch.cwd).toBeNull();
    expect(launch.env.NULLIUS_WORKSPACE_ROOT).toBe(fs.realpathSync(moved));
  });

  it('applies private per-server values without putting them in distribution metadata', () => {
    const f = fixture();
    fs.writeFileSync(f.configPath, JSON.stringify({ servers: { 'project-mcp': { env: { NULLIUS_PROJECT_ROOT: f.project, STORE_DIR: path.join(f.project, 'new-store'), TEST_SETTING: 'local' } } } }));
    const launch = resolveRuntimeLaunch('project-mcp', { ...f.env, NULLIUS_RUNTIME_CONFIG: f.configPath, TEST_SETTING: 'ambient' }, f.workspace);
    expect(launch.cwd).toBe(f.project);
    expect(launch.env.TEST_SETTING).toBe('local');
    expect(launch.env.STORE_DIR).toBe(path.join(f.project, 'new-store'));
    expect(fs.existsSync(launch.env.STORE_DIR!)).toBe(false);
    expect(fs.readFileSync(f.registryPath, 'utf8')).not.toContain(f.project);
  });

  it('loads the default XDG location and supports host-only external binding', () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.home, 'nullius'));
    fs.writeFileSync(path.join(f.home, 'nullius/runtime.json'), JSON.stringify({ servers: { 'provider-mcp': { env: { TEST_SETTING: 'xdg' } } } }));
    expect(resolveRuntimeLaunch('provider-mcp', f.env, f.workspace).env.TEST_SETTING).toBe('xdg');
    const launch = resolveRuntimeLaunch('project-mcp', { ...f.env, NULLIUS_PROJECT_ROOT: f.project, STORE_DIR: path.join(f.project, 'store') }, f.workspace);
    expect(launch.cwd).toBe(f.project);
  });

  it('fails closed for explicit missing or invalid private configuration without echoing values', () => {
    const f = fixture();
    const env = { ...f.env, NULLIUS_RUNTIME_CONFIG: f.configPath };
    expect(() => resolveRuntimeLaunch('provider-mcp', env, f.workspace)).toThrow('cannot read valid private runtime configuration');
    for (const value of ['{"private-test-value": invalid}', JSON.stringify({ servers: { 'provider-mcp': { env: { X: { private: 'test-value' } } } } }), JSON.stringify({ servers: { unknown: { env: {} } } })]) {
      fs.writeFileSync(f.configPath, value);
      let message = '';
      try { resolveRuntimeLaunch('provider-mcp', env, f.workspace); } catch (error) { message = String(error); }
      expect(message).toMatch(/configuration|profile/);
      expect(message).not.toContain('private-test-value');
      expect(message).not.toContain('test-value');
    }
  });

  it('rejects missing, relative, non-directory, repository and ancestor project roots', () => {
    const f = fixture();
    const env = { ...f.env, STORE_DIR: path.join(f.project, 'store') };
    for (const project of [undefined, 'relative', path.join(f.parent, 'absent'), path.join(f.workspace, 'server.mjs'), f.workspace, f.parent]) {
      expect(() => resolveRuntimeLaunch('project-mcp', { ...env, NULLIUS_PROJECT_ROOT: project }, f.workspace)).toThrow();
    }
  });

  it('rejects directory aliases and absent descendants that resolve back inside the installation', () => {
    const f = fixture();
    const alias = path.join(f.parent, 'alias');
    fs.symlinkSync(f.workspace, alias);
    const env = { ...f.env, NULLIUS_PROJECT_ROOT: f.project, STORE_DIR: path.join(alias, 'absent', 'store') };
    expect(() => resolveRuntimeLaunch('project-mcp', env, f.workspace)).toThrow('STORE_DIR must be outside');
    expect(() => resolveRuntimeLaunch('provider-mcp', { ...f.env, NULLIUS_PROJECT_ROOT: alias }, f.workspace)).toThrow('NULLIUS_PROJECT_ROOT must be outside');
  });

  it('rejects missing, traversal and symlink-escaped entrypoints', () => {
    const f = fixture();
    expect(() => resolveRuntimeLaunch('unknown', f.env, f.workspace)).toThrow('unknown runtime MCP');
    f.registry['provider-mcp'].entrypoint = '../outside.mjs';
    fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
    expect(() => resolveRuntimeLaunch('provider-mcp', f.env, f.workspace)).toThrow('invalid runtime server registry');
    f.registry['provider-mcp'].entrypoint = 'link.mjs';
    fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
    fs.writeFileSync(path.join(f.parent, 'outside.mjs'), '');
    fs.symlinkSync(path.join(f.parent, 'outside.mjs'), path.join(f.workspace, 'link.mjs'));
    expect(() => resolveRuntimeLaunch('provider-mcp', f.env, f.workspace)).toThrow('missing or outside');
  });

  it('rejects ambiguous CLI binding and unexpected command arguments', async () => {
    const f = fixture();
    const io = { cwd: f.project, stdout: () => {}, stderr: () => {} };
    await expect(runCli(['runtime', 'path', '--project-root', f.project], io)).rejects.toThrow('per-server');
    await expect(runCli(['runtime', 'path', 'extra'], io)).rejects.toThrow('usage:');
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('forwards %s and waits for the MCP child to exit', async signal => {
    const f = fixture();
    const dist = path.join(f.workspace, 'packages/orchestrator/dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(f.workspace, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(f.workspace, 'pnpm-workspace.yaml'), 'packages: []\n');
    fs.copyFileSync(path.join(installedRuntimeRoot(), 'packages/orchestrator/dist/cli-runtime.js'), path.join(dist, 'cli-runtime.js'));
    const launcher = path.join(f.workspace, 'launch.mjs');
    fs.writeFileSync(launcher, 'import {runRuntimeCommand} from "./packages/orchestrator/dist/cli-runtime.js"; process.exitCode = await runRuntimeCommand(["mcp", "provider-mcp"], null, {cwd:process.cwd(),stdout:s=>process.stdout.write(s),stderr:s=>process.stderr.write(s)});');
    fs.writeFileSync(path.join(f.workspace, 'server.mjs'), 'console.log(process.pid); setInterval(()=>{},1000);');
    const child = spawn(process.execPath, [launcher], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverPid: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completion = new Promise<number | null>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('runtime signal test timed out')), 5000);
        child.once('error', reject);
        child.once('close', code => resolve(code));
        child.stdout.once('data', bytes => {
          serverPid = Number(bytes.toString().trim());
          child.kill(signal);
        });
      });
      const code = await completion;
      expect(code).toBe({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
      expect(serverPid).toBeGreaterThan(0);
      expect(() => process.kill(serverPid!, 0)).toThrow();
    } finally {
      if (timer) clearTimeout(timer);
      child.kill('SIGKILL');
      if (serverPid) { try { process.kill(serverPid, 'SIGKILL'); } catch {} }
    }
  });
});
