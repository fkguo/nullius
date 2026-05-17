#!/usr/bin/env node
/**
 * CLI wrapper around migratePapersCache for shell invocation.
 *
 *   node packages/hep-mcp/dist/admin/cli-migrate-papers-cache.js \
 *     --project-root /abs/path/to/project [--apply] [--hep-data-root /abs/path] [--json]
 *
 * MCP-driven invocation (via agents) should call the `hep_admin_migrate_papers_cache`
 * tool directly; this script exists so a maintainer can run the migration
 * from a terminal without spawning an agent.
 */

import { migratePapersCache, formatMigrationReport } from './migratePapersCache.js';

interface ParsedArgs {
  project_root?: string;
  hep_data_root?: string;
  apply: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--project-root') out.project_root = argv[++i];
    else if (a === '--hep-data-root') out.hep_data_root = argv[++i];
    else if (a?.startsWith('--project-root=')) out.project_root = a.slice('--project-root='.length);
    else if (a?.startsWith('--hep-data-root=')) out.hep_data_root = a.slice('--hep-data-root='.length);
    else {
      console.error(`unknown argument: ${a}`);
      out.help = true;
    }
  }
  return out;
}

const USAGE = `Usage:
  migrate-papers-cache --project-root <abs-path> [options]

Options:
  --project-root PATH    (required) absolute path to the autoresearch project root
  --hep-data-root PATH   override <project_root>/artifacts/hep-mcp/
  --apply                actually move/swap files (default: dry-run)
  --json                 emit JSON instead of human-readable report
  -h, --help             show this help

By default this is a DRY RUN. Pass --apply to commit.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project_root) {
    process.stderr.write(USAGE);
    return args.help ? 0 : 2;
  }
  const report = await migratePapersCache({
    project_root: args.project_root,
    hep_data_root: args.hep_data_root,
    apply: args.apply,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatMigrationReport(report) + '\n');
  }
  if (report.summary.total_errors > 0) return 1;
  return 0;
}

main().then(
  code => process.exit(code),
  err => {
    process.stderr.write(`error: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
