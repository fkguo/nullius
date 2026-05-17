/**
 * Admin / maintenance tools for hep-mcp. These manage hep-mcp's own state
 * (caches, paper-cache layout, knowledge_base symlinks) and never modify the
 * irreplaceable Tier 1 work products (curator notes, research_*.md content).
 *
 * Step 3 shipped `hep_admin_migrate_papers_cache`. Step 4 added
 * `hep_admin_prune_paper_cache`. Step 5a adds `hep_admin_import_paper` (generic
 * already-have-the-PDF intake); a follow-up adds `hep_admin_link_kb_notes`.
 */

import * as path from 'node:path';

import { invalidParams } from '@autoresearch/shared';
import { z } from 'zod';

import {
  HEP_ADMIN_IMPORT_PAPER,
  HEP_ADMIN_LINK_KB_NOTES,
  HEP_ADMIN_MIGRATE_PAPERS_CACHE,
  HEP_ADMIN_PRUNE_PAPER_CACHE,
} from '../../tool-names.js';
import { importPaper } from '../../admin/importPaper.js';
import { linkKbNotes } from '../../admin/linkKbNotes.js';
import { migratePapersCache } from '../../admin/migratePapersCache.js';
import { prunePaperCache } from '../../admin/prunePaperCache.js';
import { getHepToolRiskLevel } from '../../tool-risk.js';
import type { ToolSpec } from './types.js';

const HepAdminMigratePapersCacheToolSchema = z.object({
  project_root: z
    .string()
    .min(1)
    .describe(
      'Absolute path to the autoresearch project root whose <project_root>/artifacts/hep-mcp/projects/*/papers/*/sources/latex/extracted/ directories are to be converted from pre-cache real-dirs to Tier 3 cache symlinks.',
    ),
  hep_data_root: z
    .string()
    .optional()
    .describe(
      'Override the HEP data root resolution; defaults to <project_root>/artifacts/hep-mcp/. Useful when HEP_DATA_DIR was customized for this project.',
    ),
  apply: z
    .boolean()
    .optional()
    .default(false)
    .describe('Default false (dry-run preview). Set true to actually move/swap files.'),
  // _confirm is the repo-wide destructive-tool safety gate (H-11a). The tool
  // only mutates filesystem state when both `apply=true` AND `_confirm=true`;
  // either alone is a no-op gate, providing two-key safety on real runs.
  _confirm: z
    .literal(true)
    .optional()
    .describe(
      'Required to be `true` together with `apply=true` for any filesystem mutation. Dry-run (apply=false) does not require _confirm. This protects against accidental destructive invocations from agents.',
    ),
});

const HepAdminPrunePaperCacheToolSchema = z.object({
  project_roots: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'One or more absolute paths to autoresearch project roots. The union of paper.json catalogs under <project_root>/artifacts/hep-mcp/projects/<id>/papers/<paper_id>/ forms the live set; any cache entry not referenced by this set is treated as an orphan. The list must be non-empty: calling with no roots would mark every entry as orphan and is rejected.',
    ),
  hep_data_root: z
    .string()
    .optional()
    .describe(
      'Override the HEP data root for ALL supplied project roots (rarely useful; default per-root <project_root>/artifacts/hep-mcp/).',
    ),
  apply: z
    .boolean()
    .optional()
    .default(false)
    .describe('Default false (dry-run preview). Set true together with _confirm=true to delete orphan cache entries.'),
  _confirm: z
    .literal(true)
    .optional()
    .describe('Required together with apply=true for any filesystem mutation. Dry-run does not require _confirm.'),
});

const HepAdminLinkKbNotesToolSchema = z.object({
  project_root: z
    .string()
    .min(1)
    .describe(
      'Absolute path to the autoresearch project root. The tool scans <project_root>/artifacts/hep-mcp/projects/*/papers/*/paper.json for Tier 2 catalog entries and a configurable knowledge_base directory for Tier 1 markdown notes.',
    ),
  hep_data_root: z
    .string()
    .optional()
    .describe(
      'Override the HEP data root resolution; defaults to <project_root>/artifacts/hep-mcp/.',
    ),
  kb_dir: z
    .string()
    .optional()
    .describe(
      'Override the knowledge_base directory (absolute path). If omitted, the tool auto-detects under project_root by probing .autoresearch/knowledge_base, knowledge_base/literature, then knowledge_base in that order.',
    ),
});

const HepAdminImportPaperToolSchema = z.object({
  identifier: z
    .string()
    .min(1)
    .describe(
      'Canonical paper identifier. Accepted forms: "arxiv:<id>[v<n>]", "doi:<doi>", "inspire:recid:<n>", "zotero:<lib>/<key>". Bare arxiv ids, bare DOIs, and bare INSPIRE recids are auto-prefixed. The identifier is sha256-hashed to derive the Tier 3 cache key.',
    ),
  pdf_path: z
    .string()
    .min(1)
    .describe(
      'Absolute path to a local PDF the agent has already obtained (institutional access, Zotero export, hand download, …). hep-mcp does not know or care about how the PDF was sourced — that is the caller\'s domain skill / workflow concern.',
    ),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'When true, replace any existing cache entry for this identifier with the supplied PDF. Default false: a pre-existing entry causes status=already_cached with no mutation. Overwrite is the destructive path and requires _confirm=true.',
    ),
  _confirm: z
    .literal(true)
    .optional()
    .describe(
      'Required together with overwrite=true. A first-time import does not need _confirm because it cannot clobber anything. With overwrite=true but no _confirm, the call is downgraded to a no-op preview (status=already_cached) with a warning.',
    ),
});

const RAW_ADMIN_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  {
    name: HEP_ADMIN_MIGRATE_PAPERS_CACHE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Convert pre-Step-2 per-project sources/latex/extracted/ real directories into the user-global Tier 3 cache + project-local symlinks. Dry-run by default; pass apply=true to commit. Only affects hep-mcp\'s own state (paper.json, evidence/catalog.jsonl, knowledge_base/ are untouched).',
    zodSchema: HepAdminMigratePapersCacheToolSchema,
    handler: async params => {
      // withProjectRootContract overrides our required project_root with
      // optional() at the shared registry layer (shared.ts:48-56), so we must
      // validate it ourselves at the handler. An MCP call with no project_root
      // would otherwise reach migratePapersCache() and crash on
      // path.resolve(undefined).
      if (!params.project_root || !params.project_root.trim()) {
        throw invalidParams(
          'hep_admin_migrate_papers_cache requires project_root (absolute path to the autoresearch project root).',
        );
      }
      // Handler-level destructive gate: apply=true requires _confirm=true.
      // Without _confirm, the request is downgraded to dry-run with a warning.
      const wantsApply = params.apply === true;
      const confirmed = params._confirm === true;
      const effectiveApply = wantsApply && confirmed;
      const report = await migratePapersCache({
        project_root: params.project_root,
        hep_data_root: params.hep_data_root,
        apply: effectiveApply,
      });
      if (wantsApply && !confirmed) {
        return {
          ...report,
          warning:
            'apply=true was requested but _confirm=true was not provided; returning dry-run plan only. Pass both apply=true and _confirm=true to commit.',
        };
      }
      return report;
    },
  },
  {
    name: HEP_ADMIN_PRUNE_PAPER_CACHE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Delete cache entries under ~/.autoresearch/hep-mcp/papers_cache/ that no supplied project_root references (orphans + leftover tmp staging dirs). Dry-run by default; apply=true requires _confirm=true. Unrecognized / corrupted-meta entries are preserved for manual inspection.',
    zodSchema: HepAdminPrunePaperCacheToolSchema,
    handler: async params => {
      if (!Array.isArray(params.project_roots) || params.project_roots.length === 0) {
        throw invalidParams(
          'hep_admin_prune_paper_cache requires project_roots: a non-empty array of absolute project root paths.',
        );
      }
      for (const r of params.project_roots) {
        if (!r || !r.trim()) {
          throw invalidParams('hep_admin_prune_paper_cache: every project_roots entry must be a non-empty string.');
        }
      }
      const wantsApply = params.apply === true;
      const confirmed = params._confirm === true;
      const effectiveApply = wantsApply && confirmed;
      const report = await prunePaperCache({
        project_roots: params.project_roots,
        hep_data_root: params.hep_data_root,
        apply: effectiveApply,
      });
      if (wantsApply && !confirmed) {
        return {
          ...report,
          warning:
            'apply=true was requested but _confirm=true was not provided; returning dry-run plan only. Pass both apply=true and _confirm=true to commit.',
        };
      }
      return report;
    },
  },
  {
    name: HEP_ADMIN_IMPORT_PAPER,
    tier: 'core',
    exposure: 'standard',
    description:
      'Import a locally-obtained PDF into the user-global Tier 3 paper cache under a canonical identifier (arxiv/doi/inspire/zotero). The caller is responsible for how the PDF was obtained — hep-mcp only knows about the file path. If an entry already exists, returns status=already_cached and does NOT mutate unless overwrite=true AND _confirm=true.',
    zodSchema: HepAdminImportPaperToolSchema,
    handler: async params => {
      if (!params.identifier || !params.identifier.trim()) {
        throw invalidParams(
          'hep_admin_import_paper requires identifier (canonical paper id, e.g. "doi:10.1103/X", "arxiv:2401.09012", "inspire:recid:12345").',
        );
      }
      if (!params.pdf_path || !params.pdf_path.trim()) {
        throw invalidParams('hep_admin_import_paper requires pdf_path (absolute path to a local PDF file).');
      }
      // Handler-level absolute-path check, before delegating to importPaper().
      // The pure function also enforces this, but rejecting at the MCP boundary
      // gives a clearer error and avoids a noisy stack trace for a routine
      // input mistake.
      if (!path.isAbsolute(params.pdf_path)) {
        throw invalidParams(
          `hep_admin_import_paper: pdf_path must be an absolute path, got ${JSON.stringify(params.pdf_path)}.`,
        );
      }
      // Handler-level destructive gate: overwrite=true requires _confirm=true.
      // The fresh-import case (no existing entry) is purely additive and never
      // needs _confirm — we let importPaper() decide. If overwrite=true was
      // requested but _confirm is missing, we coerce overwrite to false; if the
      // entry already exists, importPaper() will return status=already_cached
      // with no mutation. The handler then attaches a warning so the caller
      // knows their overwrite intent was downgraded.
      const wantsOverwrite = params.overwrite === true;
      const confirmed = params._confirm === true;
      const effectiveOverwrite = wantsOverwrite && confirmed;
      const report = await importPaper({
        identifier: params.identifier,
        pdf_path: params.pdf_path,
        overwrite: effectiveOverwrite,
      });
      if (wantsOverwrite && !confirmed) {
        return {
          ...report,
          warning:
            'overwrite=true was requested but _confirm=true was not provided; the call was downgraded to a non-overwrite import. ' +
            'If an entry already exists, no mutation occurred (status=already_cached). Pass both overwrite=true and _confirm=true to replace.',
        };
      }
      return report;
    },
  },
  {
    name: HEP_ADMIN_LINK_KB_NOTES,
    tier: 'core',
    exposure: 'standard',
    description:
      "Read-only reconciliation report between hep-mcp's Tier 2 paper.json catalog and the project's Tier 1 knowledge_base markdown notes. Matches by canonical_id, surfaces papers without notes (curator gap), notes without papers (orphan), and notes with no parseable identifier. Performs NO mutations.",
    zodSchema: HepAdminLinkKbNotesToolSchema,
    handler: async params => {
      // Same defensive validation pattern as the rest of the admin family —
      // withProjectRootContract may relax project_root to optional() at the
      // shared layer, so the handler enforces it explicitly.
      if (!params.project_root || !params.project_root.trim()) {
        throw invalidParams(
          'hep_admin_link_kb_notes requires project_root (absolute path to the autoresearch project root).',
        );
      }
      return linkKbNotes({
        project_root: params.project_root,
        hep_data_root: params.hep_data_root,
        kb_dir: params.kb_dir,
      });
    },
  },
];

export const ADMIN_TOOL_SPECS: ToolSpec[] = RAW_ADMIN_TOOL_SPECS.map(spec => ({
  ...spec,
  riskLevel: getHepToolRiskLevel(spec.name),
}));
