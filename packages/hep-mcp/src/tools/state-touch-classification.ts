/**
 * State-touch classification for hep-mcp tools (composite dispatcher).
 *
 * Per the 2026-05-23 P3-C-redesign code audit, hep-mcp's dispatcher wraps
 * every tool call with `withHepDataRoot(projectRootArg(args), ...)` AND
 * `withPdgDataDir(resolvedPdgDataDirForCurrentHepRoot(), ...)` (see
 * `handleToolCall` in `src/tools/dispatcher.ts`). This means even tools that
 * look like generic provider queries may write project-keyed paths when a
 * `project_root` arg is supplied.
 *
 * Three buckets per tool — verified by reading each handler:
 *
 *   ALWAYS_STATE_TOUCHING        Always writes into the caller's output_dir
 *                                inside the project.
 *                                Anchor required regardless of args.
 *
 *   VERIFY_IF_PROJECT_ROOT       Conditionally writes a project-keyed path
 *                                when `project_root` arg is present (via
 *                                hep-mcp's `withHepDataRoot` /
 *                                `withPdgDataDir` scope). Anchor required
 *                                only if `project_root` (or `output_dir`) is
 *                                in args.
 *
 *   ALWAYS_NO_STATE_TOUCH        Never reads/writes project-keyed state
 *                                regardless of args (re-exported provider
 *                                queries whose handlers use their own
 *                                package-level `getDataDir()` not affected
 *                                by hep-mcp's AsyncLocalStorage scope, plus
 *                                pure HTTP / read-only computation tools).
 *
 * IMPORTANT: This classification is per code audit, not per tool name. The
 * audit log lives in PR #32 (the originating PR for this redesign) and the
 * justification for each row is the file:line citation from the audit agent
 * output. Future maintainers must re-read the handler before changing a
 * row's bucket.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Bucket 1: ALWAYS_STATE_TOUCHING
// hep_import_from_zotero, hep_inspire_search_export,
// hep_inspire_resolve_identifiers, inspire_parse_latex and
// inspire_theoretical_conflicts require output_dir and write into it inside
// the project.
// ─────────────────────────────────────────────────────────────────────────────
const ALWAYS_STATE_TOUCHING = new Set<string>([
  // writes into output_dir
  'hep_import_from_zotero',
  // hep_inspire_*
  'hep_inspire_search_export',
  'hep_inspire_resolve_identifiers',
  // inspire_* tools that write into output_dir (required):
  'inspire_parse_latex',
  'inspire_theoretical_conflicts',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Bucket 2: VERIFY_IF_PROJECT_ROOT
// State-touching only when `project_root` / `output_dir` is in args.
// ─────────────────────────────────────────────────────────────────────────────
const VERIFY_IF_PROJECT_ROOT = new Set<string>([
  // inspire_search: with output_dir it dispatches to hep_inspire_search_export,
  // which writes into that directory inside the project (output_dir requires
  // project_root, and is also caught here for safety).
  'inspire_search',
  // inspire_paper_source: content mode writes to `getDownloadsDir()` which is
  // re-rooted under `<project_root>/artifacts/hep-mcp/downloads/` when
  // project_root is supplied.
  'inspire_paper_source',
  // inspire_cleanup_downloads: deletes from `getDownloadsDir()` (same scope).
  'inspire_cleanup_downloads',
  // pdg_* via hep-mcp: hep-mcp's withPdgDataDir reroutes PDG cache when
  // project_root is passed.
  'pdg_get',
  'pdg_get_decays',
  'pdg_get_measurements',
  'pdg_batch',
]);

const PROJECT_ROOT_ARG_KEYS = ['project_root', 'output_dir'] as const;

function hasProjectRootArg(args: Record<string, unknown>): boolean {
  for (const key of PROJECT_ROOT_ARG_KEYS) {
    const v = args[key];
    if (v !== undefined && v !== null && v !== '') return true;
  }
  return false;
}

/**
 * Returns true iff the given tool, with the given args, may read or write
 * project-keyed state via hep-mcp's composite dispatcher scope. Used to
 * decide whether to enforce the harness invocation anchor.
 *
 * Bucket details documented at module top.
 */
export function isStateTouchingHepMcp(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (ALWAYS_STATE_TOUCHING.has(toolName)) return true;
  if (VERIFY_IF_PROJECT_ROOT.has(toolName)) return hasProjectRootArg(args);
  // Default for unknown / no-state-touch tools (hep_health, arxiv_*, openalex_*,
  // hepdata_*, zotero_*, inspire_search_next / inspire_literature /
  // inspire_resolve_citekey / inspire_grade_evidence /
  // inspire_critical_analysis /
  // inspire_classify_reviews / inspire_topic_analysis /
  // inspire_network_analysis / inspire_find_connections /
  // inspire_trace_original_source / inspire_find_crossover_topics /
  // inspire_analyze_citation_stance / inspire_validate_bibliography): no anchor.
  return false;
}
