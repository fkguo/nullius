#!/usr/bin/env node
/**
 * CLI wrapper around linkKbNotes for shell invocation.
 *
 *   node packages/hep-mcp/dist/admin/cli-link-kb-notes.js \
 *     --project-root /abs/path/to/project [--kb-dir /abs/path] [--json]
 *
 * MCP-driven invocation (via agents) should call the `hep_admin_link_kb_notes`
 * tool directly; this script exists so a maintainer can survey KB-note ↔
 * paper.json linkage from a terminal without spawning an agent. The tool is
 * strictly read-only.
 */

import { linkKbNotes, formatKbLinkReport } from './linkKbNotes.js';

interface ParsedArgs {
  project_root?: string;
  hep_data_root?: string;
  kb_dir?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--project-root') out.project_root = argv[++i];
    else if (a === '--hep-data-root') out.hep_data_root = argv[++i];
    else if (a === '--kb-dir') out.kb_dir = argv[++i];
    else if (a?.startsWith('--project-root=')) out.project_root = a.slice('--project-root='.length);
    else if (a?.startsWith('--hep-data-root=')) out.hep_data_root = a.slice('--hep-data-root='.length);
    else if (a?.startsWith('--kb-dir=')) out.kb_dir = a.slice('--kb-dir='.length);
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      out.help = true;
      break;
    }
  }
  return out;
}

const USAGE = `Usage:
  link-kb-notes --project-root <abs-path> [options]

Required:
  --project-root PATH     absolute path to the autoresearch project root.

Options:
  --hep-data-root PATH    override <project_root>/artifacts/hep-mcp/
  --kb-dir PATH           override the knowledge_base directory (absolute).
                          Default: auto-detect under project_root, probing
                          .autoresearch/knowledge_base, knowledge_base/literature,
                          then knowledge_base in that order.
  --json                  emit JSON instead of human-readable report.
  -h, --help              show this help.

This tool is read-only: it never modifies paper.json or any knowledge_base
file. Use it to survey curator gaps and orphan notes before manual cleanup.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project_root) {
    process.stderr.write(USAGE);
    return args.help ? 0 : 2;
  }
  const report = await linkKbNotes({
    project_root: args.project_root,
    hep_data_root: args.hep_data_root,
    kb_dir: args.kb_dir,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatKbLinkReport(report) + '\n');
  }
  // Exit 0 always for the read-only path; the report itself carries the
  // accept/reject signal. A future caller wanting CI-style gating can parse
  // summary.total_papers_without_note > 0 from --json output.
  return 0;
}

main().then(
  code => process.exit(code),
  err => {
    process.stderr.write(`error: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
