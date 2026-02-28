import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  HEPDATA_SEARCH,
  HEPDATA_GET_RECORD,
  HEPDATA_GET_TABLE,
  HEPDATA_DOWNLOAD,
  upstreamError,
} from '@autoresearch/shared';
import { zodToMcpInputSchema } from './mcpSchema.js';
import * as client from '../api/client.js';
import { getArtifactsDir, getDataDir, ensureDir } from '../data/dataDir.js';
import { resolvePathWithinParent } from '../data/pathGuard.js';
import {
  HepDataSearchSchema,
  HepDataGetRecordSchema,
  HepDataGetTableSchema,
  HepDataDownloadSchema,
} from './schemas.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ToolExposureMode = 'standard' | 'full';
export type ToolExposure = 'standard' | 'full';

export interface ToolSpec<TSchema extends z.ZodType<any, any> = z.ZodType<any, any>> {
  name: string;
  description: string;
  exposure: ToolExposure;
  zodSchema: TSchema;
  handler: (args: z.infer<TSchema>) => Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Specs
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: HEPDATA_SEARCH,
    exposure: 'standard',
    description: `Search HEPData for experimental measurement records (network). At least one condition required.

Lookup by identifier (exact match):
  { inspire_recid: 1245023 }
  { arxiv_id: "1307.7457" }
  { doi: "10.1103/PhysRevLett.103.092301" }

Keyword search (broad text matching, less precise):
  { query: "LHCb cross section" }

Structured filters (precise; combinable with each other and with query):
  { reactions: "E+ E- --> PI+ PI-" }     reaction (INSPIRE notation: ALL CAPS, spaces around -->)
  { reactions: "PI- P --> PI- P" }        PI+/PI-/PI0/P/PBAR/E+/E-/GAMMA/K+/K-/N
  { collaboration: "LHCb" }              experiment name (case-sensitive: "LHCb" not "lhcb")
  { observables: "SIG" }                 SIG | DSIG/DOMEGA | DSIG/DPT | DSIG/DT | POL | ASYM | F2 | SLOPE | MULT
  { phrases: "Proton-Proton Scattering" } physics topic tag (title-case phrase)
  { cmenergies: "0.0,1.0" }             CM energy range in GeV as "min,max"
  { subject_areas: "hep-ex" }            arXiv category: hep-ex | nucl-ex | hep-ph | hep-th | ...

Pagination and sorting (modifiers, not standalone conditions):
  { sort_by: "date" }    relevance (default) | collaborations | title | date | latest
  { page: 2, size: 25 }

Combining: filters AND-combine with each other and with query:
  { reactions: "E+ E- --> PI+ PI-", cmenergies: "0.0,2.0", sort_by: "date" }
  { query: "form factor", collaboration: "CMD-2" }
  { reactions: "P P --> P P", observables: "DSIG/DT" }

Returns total count and list of records with hepdata_id for use with hepdata_get_record / hepdata_get_table.`,
    zodSchema: HepDataSearchSchema,
    handler: async params => client.searchRecords(params),
  },

  {
    name: HEPDATA_GET_RECORD,
    exposure: 'standard',
    description: `Get HEPData record metadata and data table list (network). Requires hepdata_id from hepdata_search.

Returns title, abstract, collaborations, inspire_recid, arxiv_id, doi, and data_tables list.
Each entry in data_tables has: table_id (pass directly to hepdata_get_table), name, doi.`,
    zodSchema: HepDataGetRecordSchema,
    handler: async params => client.getRecord(params.hepdata_id),
  },

  {
    name: HEPDATA_GET_TABLE,
    exposure: 'standard',
    description: `Get numerical data from a HEPData table (network). Requires table_id from hepdata_get_record.

Each HEPData table has a globally unique internal ID. Obtain table_id from data_tables[].table_id in hepdata_get_record.

format="json" (default): structured response with:
  name, description, headers (column labels with units), values (array of rows).
  Each row: x[] for independent variables (each entry has value, or low+high for bin edges),
             y[] for dependent variables (each entry has value and errors[]{label, symerror?,
             asymerror?:{plus,minus}}). symerror = symmetric ±; asymerror = asymmetric +/-.
format="yaml": raw HEPData YAML with full error breakdown; use when you need all error sources.`,
    zodSchema: HepDataGetTableSchema,
    handler: async params => client.getTable(params.table_id, params.format),
  },

  {
    name: HEPDATA_DOWNLOAD,
    exposure: 'standard',
    description: `Download complete HEPData submission archive (zip) to local artifacts (network, writes files, requires _confirm: true).

Downloads all data tables in YAML and other formats.
Returns artifact URI, file path, file size, and table count.`,
    zodSchema: HepDataDownloadSchema,
    handler: async params => {
      const record = await client.getRecord(params.hepdata_id);
      const tablesCount = record.data_tables.length;
      const buffer = await client.downloadSubmission(params.hepdata_id);

      const dataDir = getDataDir();
      const submissionDir = resolvePathWithinParent(
        dataDir,
        path.join(getArtifactsDir(), 'submissions', String(params.hepdata_id)),
        'submission directory',
      );
      ensureDir(submissionDir);

      const destPath = path.join(submissionDir, 'hepdata_submission.zip');
      const tmpPath = `${destPath}.tmp`;

      try {
        fs.writeFileSync(tmpPath, Buffer.from(buffer));
        fs.renameSync(tmpPath, destPath);
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch (cleanupErr) {
          process.stderr.write(`[hepdata-mcp] cleanup failed for ${tmpPath}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`);
        }
        throw upstreamError(
          `Failed to write HEPData submission: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return {
        uri: `hepdata://artifacts/submissions/${params.hepdata_id}/hepdata_submission.zip`,
        file_path: destPath,
        size_bytes: buffer.byteLength,
        tables_count: tablesCount,
      };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Registry helpers
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_SPECS_BY_NAME = new Map<string, ToolSpec>(TOOL_SPECS.map(s => [s.name, s]));

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS_BY_NAME.get(name);
}

export function isToolExposed(spec: ToolSpec, mode: ToolExposureMode): boolean {
  return spec.exposure === 'standard' || mode === 'full';
}

export function getToolSpecs(mode: ToolExposureMode = 'standard'): ToolSpec[] {
  return TOOL_SPECS.filter(spec => isToolExposed(spec, mode));
}

export function getTools(mode: ToolExposureMode = 'standard') {
  return getToolSpecs(mode).map(spec => ({
    name: spec.name,
    description: spec.description,
    inputSchema: zodToMcpInputSchema(spec.zodSchema),
  }));
}
