#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { parseCliArgs } from './cli-args.js';
import { runExportCommand } from './cli-export.js';
import { renderHelp } from './cli-help.js';
import { runInitCommand } from './cli-init.js';
import {
  type CliIo,
  runApproveCommand,
  runPauseCommand,
  runResumeCommand,
  runStatusCommand,
} from './cli-lifecycle.js';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';

function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    stderr: text => process.stderr.write(text),
    stdout: text => process.stdout.write(text),
  };
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.command === 'help') {
    io.stdout(renderHelp(parsed.topic));
    return 0;
  }
  if (parsed.command === 'init') {
    await runInitCommand(parsed.projectRoot, io.cwd, parsed.passthrough, io);
    return 0;
  }
  if (parsed.command === 'export') {
    await runExportCommand(resolveLifecycleProjectRoot(parsed.projectRoot, io.cwd), io.cwd, parsed.passthrough, io);
    return 0;
  }

  const projectRoot = resolveLifecycleProjectRoot(parsed.projectRoot, io.cwd);
  if (parsed.command === 'status') {
    await runStatusCommand(projectRoot, parsed.json, io);
    return 0;
  }
  if (parsed.command === 'pause') {
    await runPauseCommand(projectRoot, parsed.note, io);
    return 0;
  }
  if (parsed.command === 'resume') {
    await runResumeCommand(projectRoot, parsed.note, io);
    return 0;
  }
  if (parsed.command === 'approve') {
    await runApproveCommand(projectRoot, parsed.approvalId, parsed.note, io);
    return 0;
  }
  throw new Error(`unsupported command: ${parsed.command}`);
}

async function main(): Promise<void> {
  try {
    process.exit(await runCli(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[error] ${message}\n`);
    process.exit(2);
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref && import.meta.url === entryHref) {
  await main();
}
