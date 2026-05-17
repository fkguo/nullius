#!/usr/bin/env node
/**
 * CLI wrapper around prunePaperCache for shell invocation.
 *
 *   node packages/hep-mcp/dist/admin/cli-prune-paper-cache.js \
 *     --project-root /abs/path/A --project-root /abs/path/B [--apply] [--json]
 *
 * MCP-driven invocation (via agents) should call the `hep_admin_prune_paper_cache`
 * tool directly; this script exists so a maintainer can run the prune from a
 * terminal without spawning an agent.
 */

import { prunePaperCache, formatPruneReport } from './prunePaperCache.js';

interface ParsedArgs {
  project_roots: string[];
  hep_data_root?: string;
  apply: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { project_roots: [], apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--project-root') {
      const v = argv[++i];
      if (v) out.project_roots.push(v);
    } else if (a === '--hep-data-root') out.hep_data_root = argv[++i];
    else if (a?.startsWith('--project-root=')) out.project_roots.push(a.slice('--project-root='.length));
    else if (a?.startsWith('--hep-data-root=')) out.hep_data_root = a.slice('--hep-data-root='.length);
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      out.help = true;
      break; // stop parsing on first unknown to avoid noisy multi-line stderr
    }
  }
  return out;
}

const USAGE = `Usage:
  prune-paper-cache --project-root <abs-path> [--project-root <abs-path> ...] [options]

Options:
  --project-root PATH     (required, repeatable) absolute path to a project_root.
                          The union of all supplied project paper.json catalogs
                          forms the live set; everything else in the cache is
                          treated as orphan.
  --hep-data-root PATH    override <project_root>/artifacts/hep-mcp/ for ALL roots
  --apply                 actually delete orphans + tmp staging dirs (default: dry-run)
  --json                  emit JSON instead of human-readable report
  -h, --help              show this help

The cache root is ~/.autoresearch/hep-mcp/papers_cache/ (override with
HEP_PAPERS_CACHE_DIR env). At least one --project-root is REQUIRED — calling
with no roots would treat every cache entry as orphan, which is almost
certainly not what you want.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.project_roots.length === 0) {
    process.stderr.write(USAGE);
    return args.help ? 0 : 2;
  }
  const report = await prunePaperCache({
    project_roots: args.project_roots,
    hep_data_root: args.hep_data_root,
    apply: args.apply,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatPruneReport(report) + '\n');
  }
  const failed = report.plans.filter(p => p.applied === false).length;
  return failed > 0 ? 1 : 0;
}

main().then(
  code => process.exit(code),
  err => {
    process.stderr.write(`error: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
