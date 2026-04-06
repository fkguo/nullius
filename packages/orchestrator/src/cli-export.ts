import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type CliIo } from './cli-lifecycle.js';
import { StateManager } from './state-manager.js';
import { resolveUserPath } from './project-policy.js';

type ExportOptions = { includeKbProfile: boolean; out: string | null; runId: string | null };

function parseExportArgs(args: string[]): ExportOptions {
  const options: ExportOptions = { includeKbProfile: false, out: null, runId: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const [flag, inlineValue] = arg.split('=', 2);
    if (arg === '--include-kb-profile') options.includeKbProfile = true;
    else if (flag === '--run-id' || flag === '--out') {
      const value = inlineValue ?? args[++index] ?? '';
      if (!value || value.startsWith('-')) throw new Error(`missing value for ${flag}`);
      if (flag === '--run-id') options.runId = value;
      else options.out = value;
    } else {
      throw new Error(`unknown export argument: ${arg}`);
    }
  }
  return options;
}

function relativePath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, '/');
}

function safeKbFile(projectRoot: string, candidatePath: string): string {
  const normalized = candidatePath.replaceAll('\\', '/').replace(/^\.\//u, '').trim();
  if (!normalized) throw new Error('empty path');
  if (path.isAbsolute(normalized) || normalized.startsWith('~') || path.parse(normalized).root) throw new Error(`absolute path is not allowed: ${normalized}`);
  if (normalized.split('/').includes('..')) throw new Error(`path traversal is not allowed: ${normalized}`);
  const resolved = path.resolve(projectRoot, normalized);
  const kbRoot = path.resolve(projectRoot, 'knowledge_base');
  const relative = path.relative(kbRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`path is outside knowledge_base/: ${normalized}`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`missing file: ${normalized}`);
  return resolved;
}

function writeEmptyZip(outPath: string): void {
  fs.writeFileSync(outPath, Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
}

export async function runExportCommand(projectRoot: string, cwd: string, args: string[], io: CliIo): Promise<void> {
  const options = parseExportArgs(args);
  const state = new StateManager(projectRoot).readState();
  const runId = options.runId ?? state.run_id;
  if (!runId) throw new Error('missing run_id (pass --run-id or start a run first)');

  const outPath = options.out ? resolveUserPath(options.out, cwd) : path.join(projectRoot, 'exports', `${runId}.zip`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const files = new Set<string>();
  for (const baseDir of [path.join(projectRoot, 'artifacts', 'runs', runId), path.join(projectRoot, 'team', 'runs', runId)]) {
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files.add(path.join(entry.parentPath, entry.name));
    }
  }

  if (options.includeKbProfile) {
    const profilePath = path.join(projectRoot, 'artifacts', 'runs', runId, 'kb_profile', 'kb_profile.json');
    if (!fs.existsSync(profilePath)) throw new Error(`--include-kb-profile requires kb_profile.json: ${relativePath(projectRoot, profilePath)}`);
    const payload = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as Record<string, unknown>;
    const selected = Array.isArray(payload.selected) ? payload.selected : [];
    const candidates = [
      typeof payload.kb_index_path === 'string' ? payload.kb_index_path : null,
      typeof payload.source === 'string' ? payload.source : null,
      ...selected.map(item => typeof item === 'object' && item && typeof (item as { path?: unknown }).path === 'string' ? String((item as { path: string }).path) : null),
    ].filter((value): value is string => Boolean(value?.trim()));
    const issues: string[] = [];
    for (const candidate of new Set(candidates)) {
      try {
        files.add(safeKbFile(projectRoot, candidate));
      } catch (error) {
        issues.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (issues.length > 0) throw new Error(`kb-profile export safety check failed:\n${issues.slice(0, 10).map(item => `- ${item}`).join('\n')}`);
  }

  fs.rmSync(outPath, { force: true });
  const archiveEntries = [...files].map(filePath => relativePath(projectRoot, filePath)).sort();
  if (archiveEntries.length === 0) writeEmptyZip(outPath);
  else {
    const result = spawnSync('zip', ['-q', outPath, '-@'], { cwd: projectRoot, encoding: 'utf-8', input: `${archiveEntries.join('\n')}\n` });
    if (result.status !== 0) throw new Error(result.stderr?.trim() || `zip failed with status ${String(result.status)}`);
  }
  io.stdout(`[ok] wrote: ${outPath}\n`);
}
