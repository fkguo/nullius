import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { CliIo } from './cli.js';

type ServerDefinition = {
  entrypoint: string;
  project_root: 'required' | 'optional';
  required_directories: string[];
};
type RuntimeLaunch = { entrypoint: string; env: NodeJS.ProcessEnv; cwd: string | null };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(filename: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8')) as unknown;
  } catch {
    // JSON parser errors can quote private configuration values.
    throw new Error(`cannot read valid ${label} JSON`);
  }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function installedRuntimeRoot(): string {
  const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
  if (!fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))) {
    throw new Error('Nullius runtime is incomplete; install and build the source workspace');
  }
  return root;
}

function registry(root: string): Record<string, ServerDefinition> {
  const data = readJson(path.join(root, 'packages/skills-market/runtime-servers.json'), 'runtime server registry');
  if (!record(data)) throw new Error('invalid runtime server registry');
  const result: Record<string, ServerDefinition> = Object.create(null);
  for (const [name, value] of Object.entries(data)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !record(value)
      || Object.keys(value).some(key => !['entrypoint', 'project_root', 'required_directories'].includes(key))
      || typeof value.entrypoint !== 'string' || path.isAbsolute(value.entrypoint)
      || value.entrypoint.split(/[\\/]/).some(part => part === '..' || part === '')
      || !['required', 'optional'].includes(String(value.project_root))
      || !Array.isArray(value.required_directories)
      || !value.required_directories.every(key => typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key))) {
      throw new Error('invalid runtime server registry entry');
    }
    result[name] = value as ServerDefinition;
  }
  return result;
}

function serverEnvironment(env: NodeJS.ProcessEnv, servers: Record<string, ServerDefinition>, name: string): NodeJS.ProcessEnv {
  const explicit = env.NULLIUS_RUNTIME_CONFIG;
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), '.config');
  const filename = explicit ?? path.join(configHome, 'nullius', 'runtime.json');
  if (!path.isAbsolute(filename)) throw new Error('NULLIUS_RUNTIME_CONFIG and the configuration home must be absolute');
  if (!fs.existsSync(filename) && explicit === undefined) return { ...env };
  const data = readJson(filename, 'private runtime configuration');
  if (!record(data) || Object.keys(data).some(key => key !== 'servers') || !record(data.servers)) {
    throw new Error('private runtime configuration requires a servers object');
  }
  for (const [server, profile] of Object.entries(data.servers)) {
    if (!Object.hasOwn(servers, server) || !record(profile)
      || Object.keys(profile).some(key => key !== 'env') || !record(profile.env)
      || !Object.entries(profile.env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
        && typeof value === 'string' && !value.includes('\0'))) {
      throw new Error('invalid private runtime server profile; expected registered server names and string environment values');
    }
  }
  const profile = data.servers[name] as { env: Record<string, string> } | undefined;
  return { ...env, ...profile?.env };
}

function externalDirectory(value: string | undefined, root: string, label: string, mustExist: boolean): string {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must name an absolute external directory`);
  let ancestor = path.normalize(value);
  const missing: string[] = [];
  // Canonicalize the nearest existing ancestor, including symlinks, before
  // accepting a new data directory that the provider will create later.
  while (!fs.existsSync(ancestor)) {
    if (mustExist || path.dirname(ancestor) === ancestor) throw new Error(`${label} must name an existing directory`);
    missing.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  if (!fs.statSync(ancestor).isDirectory()) throw new Error(`${label} must name a directory`);
  const canonical = path.join(fs.realpathSync(ancestor), ...missing);
  if (within(root, canonical) || within(canonical, root)) {
    throw new Error(`${label} must be outside the Nullius installation and cannot contain it`);
  }
  return canonical;
}

export function resolveRuntimeLaunch(name: string, env: NodeJS.ProcessEnv = process.env, workspace = installedRuntimeRoot()): RuntimeLaunch {
  const root = fs.realpathSync(workspace);
  const servers = registry(root);
  if (!Object.hasOwn(servers, name)) throw new Error('unknown runtime MCP server; consult the installed runtime registry');
  const definition = servers[name]!;
  let entrypoint: string;
  try {
    entrypoint = fs.realpathSync(path.join(root, definition.entrypoint));
    if (!within(root, entrypoint) || !fs.statSync(entrypoint).isFile()) throw new Error();
  } catch {
    throw new Error('runtime MCP entrypoint is missing or outside the installation; build the source workspace');
  }
  const resolvedEnv = serverEnvironment(env, servers, name);
  let cwd: string | null = null;
  if (definition.project_root === 'required' || resolvedEnv.NULLIUS_PROJECT_ROOT) {
    cwd = externalDirectory(resolvedEnv.NULLIUS_PROJECT_ROOT, root, 'NULLIUS_PROJECT_ROOT', true);
    resolvedEnv.NULLIUS_PROJECT_ROOT = cwd;
  }
  for (const key of definition.required_directories) {
    resolvedEnv[key] = externalDirectory(resolvedEnv[key], root, key, false);
  }
  resolvedEnv.NULLIUS_WORKSPACE_ROOT = root;
  return { entrypoint, env: resolvedEnv, cwd };
}

export async function runRuntimeCommand(args: string[], projectRoot: string | null, io: CliIo): Promise<number> {
  if (projectRoot !== null) throw new Error('runtime uses per-server NULLIUS_PROJECT_ROOT in the host environment or private runtime configuration');
  if (args.length === 1 && args[0] === 'path') {
    io.stdout(`${installedRuntimeRoot()}\n`);
    return 0;
  }
  if (args.length !== 2 || args[0] !== 'mcp') throw new Error('usage: nullius runtime path | nullius runtime mcp <server>');
  const launch = resolveRuntimeLaunch(args[1]!);
  if (launch.cwd !== null) process.chdir(launch.cwd);
  // A separate entrypoint avoids an ESM top-level-await cycle when a provider
  // imports the orchestrator barrel, which itself exports runCli.
  const child = spawn(process.execPath, [launch.entrypoint], { env: launch.env, stdio: 'inherit' });
  const interrupt = () => { child.kill('SIGINT'); };
  const terminate = () => { child.kill('SIGTERM'); };
  const hangup = () => { child.kill('SIGHUP'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', hangup);
  process.on('exit', terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      const signalCodes: Record<string, number> = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 };
      child.once('error', () => reject(new Error('could not start runtime MCP process')));
      child.once('close', (code, signal) => resolve(code ?? signalCodes[signal ?? ''] ?? 1));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.off('SIGHUP', hangup);
    process.off('exit', terminate);
  }
}
