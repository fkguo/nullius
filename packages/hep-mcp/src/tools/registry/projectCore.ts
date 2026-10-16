import {
  HEP_HEALTH,
  HEP_INSPIRE_SEARCH_EXPORT,
  HEP_INSPIRE_RESOLVE_IDENTIFIERS,
} from '../../tool-names.js';
import { hepInspireSearchExport } from '../../core/inspire/searchExport.js';
import { hepInspireResolveIdentifiers } from '../../core/inspire/resolveIdentifiers.js';
import { getHepHealth } from '../utils/health.js';
import type { ToolSpec } from './types.js';
import {
  HepHealthToolSchema,
  HepInspireSearchExportToolSchema,
  HepInspireResolveIdentifiersToolSchema,
} from './projectSchemas.js';

export const RAW_PROJECT_CORE_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  {
    name: HEP_HEALTH,
    title: 'hep-mcp health check',
    tier: 'core',
    exposure: 'standard',
    description:
      'Server health/config snapshot + optional INSPIRE connectivity probe (local-only; network optional).',
    zodSchema: HepHealthToolSchema,
    handler: async params =>
      getHepHealth({ check_inspire: params.check_inspire, inspire_timeout_ms: params.inspire_timeout_ms }),
  },
  {
    name: HEP_INSPIRE_SEARCH_EXPORT,
    title: 'Export INSPIRE search',
    tier: 'core',
    exposure: 'standard',
    description:
      'Export an INSPIRE search (safe pagination) into output_dir inside project_root (jsonl/json records + meta + the INSPIRE requests/responses used). Network (INSPIRE); returns project-relative paths + summary.',
    zodSchema: HepInspireSearchExportToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const sizeProvided = Object.prototype.hasOwnProperty.call(raw, 'size');
      const maxResultsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_results');
      return hepInspireSearchExport({
        output_dir: params.output_dir,
        query: params.query,
        sort: params.sort,
        size: params.size,
        max_results: params.max_results,
        output_format: params.output_format,
        artifact_name: params.artifact_name,
        meta_artifact_name: params.meta_artifact_name,
        budget_hints: {
          size_provided: sizeProvided,
          max_results_provided: maxResultsProvided,
        },
      });
    },
  },
  {
    name: HEP_INSPIRE_RESOLVE_IDENTIFIERS,
    title: 'Resolve INSPIRE identifiers',
    tier: 'core',
    exposure: 'standard',
    description:
      'Batch resolve identifiers (recid/arXiv/DOI) to INSPIRE recids, writing the mapping + meta + the INSPIRE requests/responses used into output_dir inside project_root (network; returns project-relative paths + summary).',
    zodSchema: HepInspireResolveIdentifiersToolSchema,
    handler: async params =>
      hepInspireResolveIdentifiers({
        output_dir: params.output_dir,
        identifiers: params.identifiers,
        artifact_name: params.artifact_name,
        meta_artifact_name: params.meta_artifact_name,
      }),
  },
];
