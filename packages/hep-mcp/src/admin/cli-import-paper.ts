#!/usr/bin/env node
/**
 * CLI wrapper around importPaper for shell invocation.
 *
 *   node packages/hep-mcp/dist/admin/cli-import-paper.js \
 *     --identifier doi:10.1103/PhysRevD.110.012345 \
 *     --pdf /abs/path/to/paper.pdf [--overwrite] [--json]
 *
 * MCP-driven invocation (via agents) should call the `hep_admin_import_paper`
 * tool directly; this script exists so a maintainer can import a PDF from a
 * terminal without spawning an agent. `--overwrite` is the destructive path
 * and requires `--confirm` as a CLI-level analogue of `_confirm=true`.
 */

import { importPaper, formatImportReport } from './importPaper.js';

interface ParsedArgs {
  identifier?: string;
  pdf_path?: string;
  overwrite: boolean;
  confirm: boolean;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { overwrite: false, confirm: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--overwrite') out.overwrite = true;
    else if (a === '--confirm') out.confirm = true;
    else if (a === '--json') out.json = true;
    else if (a === '--identifier') out.identifier = argv[++i];
    else if (a === '--pdf' || a === '--pdf-path') out.pdf_path = argv[++i];
    else if (a?.startsWith('--identifier=')) out.identifier = a.slice('--identifier='.length);
    else if (a?.startsWith('--pdf=')) out.pdf_path = a.slice('--pdf='.length);
    else if (a?.startsWith('--pdf-path=')) out.pdf_path = a.slice('--pdf-path='.length);
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      out.help = true;
      break; // stop parsing on first unknown to avoid noisy multi-line stderr
    }
  }
  return out;
}

const USAGE = `Usage:
  import-paper --identifier <canonical-id> --pdf <abs-path> [options]

Required:
  --identifier ID         canonical paper identifier; accepted forms:
                          "arxiv:<id>[v<n>]", "doi:<doi>", "inspire:recid:<n>",
                          "zotero:<lib>/<key>". Bare arxiv ids / DOIs / INSPIRE
                          recids are auto-prefixed.
  --pdf PATH              absolute path to a local PDF to import.

Options:
  --overwrite             if the cache already has an entry for this identifier,
                          replace it. Requires --confirm. Without --confirm an
                          overwrite request is downgraded to a no-op preview
                          (status=already_cached).
  --confirm               required together with --overwrite to actually replace.
  --json                  emit JSON instead of human-readable report.
  -h, --help              show this help.

The cache root is ~/.autoresearch/hep-mcp/papers_cache/ (override with
HEP_PAPERS_CACHE_DIR env). A first-time import is purely additive and never
requires --confirm.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.identifier || !args.pdf_path) {
    process.stderr.write(USAGE);
    return args.help ? 0 : 2;
  }
  // CLI-level dual-key gate: --overwrite without --confirm is downgraded to a
  // non-overwrite call. This mirrors the MCP-tool handler's behaviour.
  const effectiveOverwrite = args.overwrite && args.confirm;
  const downgraded = args.overwrite && !args.confirm;
  const report = await importPaper({
    identifier: args.identifier,
    pdf_path: args.pdf_path,
    overwrite: effectiveOverwrite,
  });
  if (args.json) {
    const out = downgraded
      ? {
          ...report,
          warning:
            '--overwrite was requested but --confirm was not provided; the call was downgraded to a non-overwrite import.',
        }
      : report;
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.stdout.write(formatImportReport(report) + '\n');
    if (downgraded) {
      process.stderr.write(
        'warning: --overwrite without --confirm was downgraded to non-overwrite. Pass --confirm to commit a replacement.\n',
      );
    }
  }
  // Exit codes: 0 imported/overwritten/already_cached, 1 rejected. Throw paths
  // (canonicalize/path-validation errors) bubble up below.
  return report.status === 'rejected' ? 1 : 0;
}

main().then(
  code => process.exit(code),
  err => {
    process.stderr.write(`error: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
