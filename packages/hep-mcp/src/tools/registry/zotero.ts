import { TOOL_SPECS as ZOTERO_MCP_TOOL_SPECS } from '@autoresearch/zotero-mcp/tooling';
import {
  invalidParams,
  HEP_IMPORT_FROM_ZOTERO,
  INSPIRE_DEEP_RESEARCH,
  TOOL_RISK_LEVELS,
  type ToolRiskLevel,
} from '@autoresearch/shared';
import { hepImportFromZotero } from '../../core/zotero/tools.js';
import { withNextActions } from '../utils/discoveryHints.js';
import type { ToolSpec } from './types.js';
import { HepImportFromZoteroToolSchema } from './projectSchemas.js';

function isZoteroIntegrationEnabled(): boolean {
  const raw = process.env.HEP_ENABLE_ZOTERO;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === '') return true;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw invalidParams('Invalid HEP_ENABLE_ZOTERO (expected 0/1/true/false/yes/no/on/off)', {
    raw,
    normalized: v,
  });
}

const ZOTERO_INTEGRATION_ENABLED = isZoteroIntegrationEnabled();

const RAW_ZOTERO_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = ZOTERO_INTEGRATION_ENABLED
  ? [
      {
        name: HEP_IMPORT_FROM_ZOTERO,
        tier: 'core',
        exposure: 'standard',
        description:
          'Import Zotero items into a run mapping (Zotero item → identifiers → INSPIRE recid). Requires Zotero Local API; resolves via INSPIRE when needed (network) and writes `zotero_map_v1.json` artifact (Evidence-first).',
        zodSchema: HepImportFromZoteroToolSchema,
        handler: async (params, ctx) => {
          const raw = ctx.rawArgs ?? {};
          const concurrencyProvided = Object.prototype.hasOwnProperty.call(raw, 'concurrency');
          const result = await hepImportFromZotero({
            run_id: params.run_id,
            collection_key: params.collection_key,
            item_keys: params.item_keys,
            limit: params.limit,
            start: params.start,
            concurrency: params.concurrency,
            budget_hints: { concurrency_provided: concurrencyProvided },
          });
          const hasResolved = result.summary?.resolved_recids > 0;
          if (hasResolved) {
            return withNextActions(result, [{
              tool: INSPIRE_DEEP_RESEARCH,
              args: { mode: 'analyze', run_id: result.run_id },
              reason: 'Analyze the imported papers. Read zotero_map_v1.json artifact for recids.',
            }]);
          }
          return result;
        },
      },
      ...ZOTERO_MCP_TOOL_SPECS.map(
        (spec): Omit<ToolSpec, 'riskLevel'> => ({
          name: spec.name,
          tier: 'consolidated',
          exposure: spec.exposure,
          description: (() => {
            const d = String(spec.description ?? '').trim();
            if (!d) return d;
            const needsLocal = !/\blocal-only\b/i.test(d);
            if (!needsLocal) return d;
            const base = d.replace(/\.\s*$/, '');
            return `${base} (local-only).`;
          })(),
          zodSchema: spec.zodSchema,
          handler: spec.handler as unknown as ToolSpec['handler'],
        })
      ),
    ]
  : [];

export const ZOTERO_TOOL_SPECS: ToolSpec[] = RAW_ZOTERO_TOOL_SPECS.map(spec => ({
  ...spec,
  riskLevel: (TOOL_RISK_LEVELS[spec.name] ?? 'read') as ToolRiskLevel,
}));
