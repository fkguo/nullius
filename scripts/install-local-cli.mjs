#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MANAGED_MARKER = 'Nullius source-checkout CLI wrapper. Managed by pnpm install:cli.';

function usage() {
  return [
    'Usage: node scripts/install-local-cli.mjs [--bin-dir <path>] [--force] [--dry-run]',
    '',
    'Installs a user-local nullius command that runs this source checkout.',
    'Defaults:',
    '  Windows: %APPDATA%\\npm\\nullius.cmd',
    '  POSIX:   ~/.local/bin/nullius',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { binDir: null, dryRun: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--bin-dir') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error('missing value for --bin-dir');
      options.binDir = value;
    } else if (arg.startsWith('--bin-dir=')) {
      const value = arg.slice('--bin-dir='.length);
      if (!value) throw new Error('missing value for --bin-dir');
      options.binDir = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function defaultBinDir() {
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) {
      throw new Error('APPDATA is not set; pass an explicit user-local directory with --bin-dir');
    }
    return path.join(process.env.APPDATA, 'npm');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

function cmdQuote(value) {
  if (/["\r\n]/u.test(value)) throw new Error(`path cannot be represented in a cmd wrapper: ${value}`);
  return `"${value.replace(/%/gu, '%%')}"`;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function wrapperContents(nodePath, cliPath) {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      `rem ${MANAGED_MARKER}`,
      `if not exist ${cmdQuote(cliPath)} (`,
      '  echo [error] the installed nullius source-checkout target is missing. 1>&2',
      `  echo [error] missing: ${cmdQuote(cliPath)} 1>&2`,
      '  echo [error] rebuild the checkout and rerun: pnpm install:cli 1>&2',
      '  exit /b 127',
      ')',
      `${cmdQuote(nodePath)} ${cmdQuote(cliPath)} %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    'set -eu',
    `# ${MANAGED_MARKER}`,
    `if [ ! -e ${shellQuote(cliPath)} ]; then`,
    "  printf '%s\\n' '[error] the installed nullius source-checkout target is missing.' >&2",
    `  printf '%s\\n' ${shellQuote(`[error] missing: ${cliPath}`)} >&2`,
    "  printf '%s\\n' '[error] rebuild the checkout and rerun: pnpm install:cli' >&2",
    '  exit 127',
    'fi',
    `exec ${shellQuote(nodePath)} ${shellQuote(cliPath)} "$@"`,
    '',
  ].join('\n');
}

function normalizedPath(value) {
  const resolved = path.resolve(value.replace(/^"|"$/gu, ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function directoryIsOnPath(binDir) {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  const expected = normalizedPath(binDir);
  return pathEnv.split(path.delimiter).some(entry => entry && normalizedPath(entry) === expected);
}

function installWrapper(wrapperPath, content, existingIsSymlink) {
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  if (existingIsSymlink) fs.unlinkSync(wrapperPath);
  const tempPath = path.join(
    path.dirname(wrapperPath),
    `.${path.basename(wrapperPath)}.${process.pid}.${Date.now().toString(36)}.partial`,
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o755);
    fs.writeFileSync(fd, content, 'utf8');
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o755);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, wrapperPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const cliPath = path.join(repoRoot, 'packages', 'orchestrator', 'dist', 'cli.js');
  if (!fs.existsSync(cliPath)) {
    throw new Error(`built nullius CLI not found: ${cliPath}\nRun pnpm -r build before pnpm install:cli.`);
  }

  const binDir = path.resolve(options.binDir ?? defaultBinDir());
  const wrapperPath = path.join(binDir, process.platform === 'win32' ? 'nullius.cmd' : 'nullius');
  const content = wrapperContents(process.execPath, cliPath);
  let wrapperEntryExists = false;
  let existingIsSymlink = false;
  try {
    const stat = fs.lstatSync(wrapperPath);
    wrapperEntryExists = true;
    existingIsSymlink = stat.isSymbolicLink();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (wrapperEntryExists) {
    const existing = existingIsSymlink ? '' : fs.readFileSync(wrapperPath, 'utf8');
    if ((existingIsSymlink || (existing !== content && !existing.includes(MANAGED_MARKER))) && !options.force) {
      throw new Error(`refusing to replace unmanaged command: ${wrapperPath}\nRe-run with --force only after reviewing that file.`);
    }
  }

  if (options.dryRun) {
    process.stdout.write(`[dry-run] would install: ${wrapperPath}\n`);
  } else {
    installWrapper(wrapperPath, content, existingIsSymlink);
    process.stdout.write(`[ok] installed: ${wrapperPath}\n`);
  }
  process.stdout.write(`[ok] source CLI: ${cliPath}\n`);
  if (directoryIsOnPath(binDir)) {
    process.stdout.write(`[ok] wrapper directory is on PATH: ${binDir}\n`);
  } else {
    process.stdout.write(`[warn] wrapper directory is not on the current PATH: ${binDir}\n`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[error] ${message}\n`);
  process.exitCode = 1;
}
