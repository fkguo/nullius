import * as path from 'path';
import { z } from 'zod';
import {
  HEPDATA_SEARCH,
  HEPDATA_GET_RECORD,
  HEPDATA_GET_TABLE,
  HEPDATA_DOWNLOAD,
  upstreamError,
  writeBytesAtomicDurable,
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
  { page: 2, size: 25 }  single page; size capped at 25
  { max_results: 100 }   bounded auto-pagination: fetch successive pages until this many
                         results are collected (or results run out). Omit for single-page
                         (size). HARD cap 200 — larger values are clamped to 200.

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
format="yaml": raw HEPData YAML with full error breakdown; use when you need all error sources.
format="csv": raw HEPData CSV text for the table.
For heavy/binary formats (root, yoda, yoda1, yoda.h5) or a whole-submission archive, use hepdata_download.`,
    zodSchema: HepDataGetTableSchema,
    handler: async params => client.getTable(params.table_id, params.format),
  },

  {
    name: HEPDATA_DOWNLOAD,
    exposure: 'standard',
    description: `Download a complete HEPData submission to local artifacts (network, writes files, requires _confirm: true).

format="original" (default): the full submission zip — all data tables in YAML and other formats.
format="json": a single submission .json file.
format ∈ {csv, root, yaml, yoda, yoda1, yoda.h5}: HEPData returns a .tar.gz archive of every table in that format.
Each format is written to its own file under the submission artifacts dir, so formats do not overwrite each other.
Returns artifact URI, file path, file size, and table count.`,
    zodSchema: HepDataDownloadSchema,
    handler: async params => {
      // tables_count stays best-effort and uniform across formats: one cheap
      // metadata request gives the table count for the returned contract,
      // matching the historical original/json behavior.
      const record = await client.getRecord(params.hepdata_id);
      const tablesCount = record.data_tables.length;
      const buffer = await client.downloadSubmission(params.hepdata_id, params.format);

      const dataDir = getDataDir();
      const submissionDir = resolvePathWithinParent(
        dataDir,
        path.join(getArtifactsDir(), 'submissions', String(params.hepdata_id)),
        'submission directory',
      );
      ensureDir(submissionDir);

      // Per-format destination filename so multiple downloads of the same
      // submission coexist. `original` keeps the historical zip name/URI.
      const fileName = submissionFileName(params.format);
      const destPath = path.join(submissionDir, fileName);

      try {
        // writeBytesAtomicDurable: mkdir + tmp + write + fsync + rename +
        // parent-dir fsync; tmp-file cleanup is best-effort inside the
        // primitive, so the outer catch block no longer needs to chase a
        // stray .tmp sidecar.
        writeBytesAtomicDurable(destPath, Buffer.from(buffer));
      } catch (err) {
        throw upstreamError(
          `Failed to write HEPData submission: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return {
        uri: `hepdata://artifacts/submissions/${params.hepdata_id}/${fileName}`,
        file_path: destPath,
        size_bytes: buffer.byteLength,
        tables_count: tablesCount,
      };
    },
  },
];

// Map a download format to its on-disk filename. `original` is the historical
// submission zip; `json` is a single .json; the science formats arrive as a
// .tar.gz archive (filename tagged with the format so they never collide).
function submissionFileName(format: z.infer<typeof HepDataDownloadSchema>['format']): string {
  if (format === 'original') return 'hepdata_submission.zip';
  if (format === 'json') return 'hepdata_submission.json';
  // Sanitize the format token for use in a filename (yoda.h5 -> yoda_h5).
  const tag = format.replace(/[^a-z0-9]+/gi, '_');
  return `hepdata_submission_${tag}.tar.gz`;
}

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
