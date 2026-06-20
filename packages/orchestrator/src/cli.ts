#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { parseCliArgs } from './cli-args.js';
import { renderHelp } from './cli-help.js';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';

type CliIo = {
  cwd: string;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
};

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
    const { runInitCommand } = await import('./cli-init.js');
    await runInitCommand(parsed.projectRoot, io.cwd, parsed.passthrough, io);
    return 0;
  }
  if (parsed.command === 'export') {
    const { runExportCommand } = await import('./cli-export.js');
    await runExportCommand(resolveLifecycleProjectRoot(parsed.projectRoot, io.cwd), io.cwd, parsed.passthrough, io);
    return 0;
  }
  if (parsed.command === 'workflow-plan') {
    const { runWorkflowPlanCommand } = await import('./cli-workflow-plan.js');
    await runWorkflowPlanCommand(parsed, io);
    return 0;
  }
  if (parsed.command === 'run') {
    const { runCommand } = await import('./cli-run.js');
    return runCommand(parsed, io);
  }
  if (parsed.command === 'graph') {
    const { runGraphCommand } = await import('./cli-graph.js');
    return runGraphCommand(parsed, io);
  }

  const projectRoot = resolveLifecycleProjectRoot(parsed.projectRoot, io.cwd);
  if (parsed.command === 'verify') {
    const { runVerifyCommand } = await import('./cli-lifecycle.js');
    await runVerifyCommand(projectRoot, parsed, io);
    return 0;
  }
  if (parsed.command === 'final-conclusions') {
    const { runFinalConclusionsCommand } = await import('./cli-lifecycle.js');
    await runFinalConclusionsCommand(projectRoot, parsed.runId, parsed.note, io);
    return 0;
  }
  if (parsed.command === 'proposal-decision') {
    const { runProposalDecisionCommand } = await import('./cli-lifecycle.js');
    await runProposalDecisionCommand(projectRoot, parsed, io);
    return 0;
  }
  if (parsed.command === 'status') {
    const { runStatusCommand } = await import('./cli-lifecycle.js');
    await runStatusCommand(projectRoot, parsed.json, io);
    return 0;
  }
  if (parsed.command === 'pause') {
    const { runPauseCommand } = await import('./cli-lifecycle.js');
    await runPauseCommand(projectRoot, parsed.note, io);
    return 0;
  }
  if (parsed.command === 'resume') {
    const { runResumeCommand } = await import('./cli-lifecycle.js');
    await runResumeCommand(projectRoot, parsed.note, parsed.force, io);
    return 0;
  }
  if (parsed.command === 'approve') {
    const { runApproveCommand } = await import('./cli-lifecycle.js');
    await runApproveCommand(projectRoot, parsed.approvalId, parsed.note, io);
    return 0;
  }
  if (parsed.command === 'integrity-record') {
    const { runIntegrityRecordCommand } = await import('./cli-lifecycle.js');
    await runIntegrityRecordCommand(projectRoot, parsed, io);
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
