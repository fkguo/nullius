/**
 * Admin / maintenance tools for hep-mcp. These manage hep-mcp's own state
 * (caches, paper-cache layout, eventual prune / import / kb-link reconciler)
 * and never modify human/agent work products (knowledge_base/, research_*.md).
 *
 * Step 3 ships `hep_admin_migrate_papers_cache`. Steps 4–5 will add prune /
 * import / link-kb-notes here.
 */

import { invalidParams } from '@autoresearch/shared';
import { z } from 'zod';

import { HEP_ADMIN_MIGRATE_PAPERS_CACHE, HEP_ADMIN_PRUNE_PAPER_CACHE } from '../../tool-names.js';
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
];

export const ADMIN_TOOL_SPECS: ToolSpec[] = RAW_ADMIN_TOOL_SPECS.map(spec => ({
  ...spec,
  riskLevel: getHepToolRiskLevel(spec.name),
}));
