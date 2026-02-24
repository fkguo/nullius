import { z, ZodError } from 'zod';
import { zodToMcpInputSchema } from './mcpSchema.js';
import { getArtifactsDir, getDataDir } from '../data/dataDir.js';
import { getFileMetadata, getPdgDbPathFromEnv, requirePdgDbPathFromEnv } from '../db/pdgDb.js';
import { readPdgInfoMap } from '../db/pdgInfo.js';
import { findPdgParticlesByMcid, findPdgParticlesByName, findPdgParticlesByPdgid } from '../db/particles.js';
import type { NameMatchMode } from '../db/particles.js';
import { getPdgidRowByPdgid } from '../db/pdgid.js';
import {
  findPdgReferences,
  getPdgReferenceByDocumentId,
  getPdgReferenceById,
  getPdgReferencesByIds,
} from '../db/references.js';
import {
  invalidParams,
  McpError,
  notFound,
  PDG_INFO,
  PDG_FIND_PARTICLE,
  PDG_FIND_REFERENCE,
  PDG_GET_REFERENCE,
  PDG_GET_PROPERTY,
  PDG_GET,
  PDG_GET_DECAYS,
  PDG_GET_MEASUREMENTS,
  PDG_BATCH,
} from '@autoresearch/shared';
import { sqlite3JsonQuery, sqlStringLiteral } from '../db/sqlite3Cli.js';
import { defaultArtifactName, writeJsonArtifact, writeJsonlArtifact } from '../artifacts.js';
import { requireUniqueBaseParticle } from './resolveParticle.js';
import { chooseEdition } from './editions.js';
import { formatPdgDisplayText } from './displayText.js';
import { normalizeParticleNameInput } from './nameNormalization.js';
import { deriveWidthFromLifetime } from './derivedWidth.js';

export type ToolExposureMode = 'standard' | 'full';
export type ToolExposure = 'standard' | 'full';

export interface ToolHandlerContext {}

export interface ToolSpec<TSchema extends z.ZodType<any, any> = z.ZodType<any, any>> {
  name: string;
  description: string;
  exposure: ToolExposure;
  /** Tool input schema (SSOT) */
  zodSchema: TSchema;
  /** Business handler called with parsed params */
  handler: (params: z.output<TSchema>, ctx: ToolHandlerContext) => Promise<unknown>;
}

export function isToolExposed(spec: ToolSpec, mode: ToolExposureMode): boolean {
  return mode === 'full' ? true : spec.exposure === 'standard';
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: U[] = new Array(items.length);

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) break;
      results[index] = await mapper(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

const PdgInfoToolSchema = z.object({});
const IntStringSchema = z
  .string()
  .trim()
  .regex(/^-?\d+$/, { message: 'must be an integer string' })
  .transform(v => Number(v));
const IntLikeSchema = z.union([z.number().int(), IntStringSchema]);
const PdgFindParticleToolSchema = z
  .object({
    name: z.string().min(1).optional(),
    mcid: IntLikeSchema.optional(),
    pdg_code: IntLikeSchema.optional(),
    pdgid: z.string().min(1).optional(),
    case_sensitive: z.boolean().optional().default(false),
    match: z.enum(['exact', 'prefix', 'contains']).optional().default('exact'),
    limit: z.number().int().positive().max(50).optional().default(20),
    start: z.number().int().nonnegative().optional().default(0),
  })
  .refine(
    v => {
      const keys = [v.name, v.mcid, v.pdg_code, v.pdgid].filter(x => x !== undefined);
      return keys.length === 1;
    },
    { message: 'Provide exactly one of: name, mcid, pdgid' }
  );

const ParticleSelectorSchema = z
  .object({
    name: z.string().min(1).optional(),
    mcid: IntLikeSchema.optional(),
    pdg_code: IntLikeSchema.optional(),
    pdgid: z.string().min(1).optional(),
    case_sensitive: z.boolean().optional().default(false),
  })
  .refine(
    v => {
      const keys = [v.name, v.mcid, v.pdg_code, v.pdgid].filter(x => x !== undefined);
      return keys.length === 1;
    },
    { message: 'Provide exactly one of: name, mcid, pdgid' }
  );

const PdgGetPropertyToolSchema = z.object({
  particle: ParticleSelectorSchema,
  property: z.enum(['mass', 'width', 'lifetime']),
  edition: z.string().min(1).optional(),
  allow_derived: z.boolean().optional().default(false),
});

const SafePathSegmentSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(s => !s.includes('/') && !s.includes('\\'), {
    message: 'must not include path separators',
  })
  .refine(s => s !== '.' && s !== '..' && !s.includes('..'), {
    message: 'contains unsafe segment',
  });

const PdgGetToolSchema = z.object({
  pdgid: z.string().min(1),
  edition: z.string().min(1).optional(),
  artifact_name: SafePathSegmentSchema.optional(),
});

const PdgGetDecaysToolSchema = z.object({
  particle: ParticleSelectorSchema,
  edition: z.string().min(1).optional(),
  start: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().positive().max(500).optional().default(200),
  artifact_name: SafePathSegmentSchema.optional(),
});

const PdgGetMeasurementsToolSchema = z.object({
  /** PDG identifier (e.g. S009T) OR, for convenience, a numeric MCID/PDG code (e.g. 111). */
  pdgid: z.string().min(1).optional(),
  /** Particle selector (preferred when you only know name/MCID). */
  particle: ParticleSelectorSchema.optional(),
  /** When `particle` (or numeric `pdgid`) is used, select a specific child PDG identifier under the base particle. */
  property_pdgid: z.string().min(1).optional(),
  /** When `particle` (or numeric `pdgid`) is used, select by PDGID.DATA_TYPE (e.g. 'T', 'M', 'BR'). */
  data_type: z.string().min(1).max(8).optional(),
  case_sensitive: z.boolean().optional().default(false),
  start: z.number().int().nonnegative().optional().default(0),
  limit: z.number().int().positive().max(200).optional().default(50),
  include_values: z.boolean().optional().default(true),
  include_reference: z.boolean().optional().default(true),
  include_footnotes: z.boolean().optional().default(true),
  artifact_name: SafePathSegmentSchema.optional(),
})
.refine(
  v => {
    const keys = [v.pdgid, v.particle].filter(x => x !== undefined);
    if (keys.length === 1) return true;
    if (keys.length === 0 && v.property_pdgid !== undefined) return true;
    return false;
  },
  { message: 'Provide exactly one of: pdgid, particle, property_pdgid' }
)
.refine(v => !(v.property_pdgid && v.data_type), { message: 'Provide at most one of: property_pdgid, data_type' });

const PdgFindReferenceToolSchema = z
  .object({
    doi: z.string().min(1).optional(),
    inspire_id: z.string().min(1).optional(),
    document_id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    match: z.enum(['exact', 'prefix', 'contains']).optional().default('contains'),
    case_sensitive: z.boolean().optional().default(false),
    limit: z.number().int().positive().max(50).optional().default(20),
    start: z.number().int().nonnegative().optional().default(0),
  })
  .refine(
    v => {
      const keys = [v.doi, v.inspire_id, v.document_id, v.title].filter(x => x !== undefined);
      return keys.length === 1;
    },
    { message: 'Provide exactly one of: doi, inspire_id, document_id, title' }
  );

const PdgGetReferenceToolSchema = z
  .object({
    id: z.number().int().positive().optional(),
    document_id: z.string().min(1).optional(),
    case_sensitive: z.boolean().optional().default(false),
  })
  .refine(
    v => {
      const keys = [v.id, v.document_id].filter(x => x !== undefined);
      return keys.length === 1;
    },
    { message: 'Provide exactly one of: id, document_id' }
  );

const PdgBatchToolNameSchema = z.enum([
  PDG_INFO,
  PDG_FIND_PARTICLE,
  PDG_FIND_REFERENCE,
  PDG_GET_PROPERTY,
  PDG_GET,
  PDG_GET_REFERENCE,
  PDG_GET_DECAYS,
  PDG_GET_MEASUREMENTS,
]);

const PdgBatchCallSchema = z.object({
  tool: PdgBatchToolNameSchema,
  arguments: z.record(z.string(), z.unknown()).optional().default({}),
});

const PdgBatchToolSchema = z.object({
  calls: z.array(PdgBatchCallSchema).min(1).max(50),
  concurrency: z.number().int().positive().max(16).optional().default(4),
  continue_on_error: z.boolean().optional().default(false),
  artifact_name: SafePathSegmentSchema.optional(),
});

function toInspireLookupIdentifiers(ref: { doi: string | null; inspire_id: string | null }): string[] {
  const out: string[] = [];
  if (ref.doi && ref.doi.startsWith('10.')) out.push(ref.doi);
  if (ref.inspire_id && /^\d+$/.test(ref.inspire_id)) out.push(ref.inspire_id);
  return out;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: PDG_INFO,
    description: 'Return PDG MCP server info and local data directories (small result; local-only).',
    exposure: 'standard',
    zodSchema: PdgInfoToolSchema,
    handler: async () => {
      const dbPath = getPdgDbPathFromEnv();
      if (!dbPath) {
        return {
          server: { name: 'pdg-mcp', version: '0.3.0' },
          db: {
            configured: false,
            reason: 'PDG_DB_PATH not set',
            how_to: 'Set PDG_DB_PATH=/abs/path/to/pdg.sqlite',
          },
          data_dir: getDataDir(),
          artifacts_dir: getArtifactsDir(),
        };
      }

      const [info, file] = await Promise.all([readPdgInfoMap(dbPath), getFileMetadata(dbPath)]);

      const parseNumberMaybe = (v: string | null | undefined): number | undefined => {
        if (v === undefined || v === null || v.trim().length === 0) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };

      return {
        server: { name: 'pdg-mcp', version: '0.3.0' },
        db: {
          configured: true,
          db_path: dbPath,
          file,
          edition: info.edition ?? undefined,
          data_release_timestamp: info.data_release_timestamp ?? undefined,
          citation: info.citation ?? undefined,
          license: info.license ?? undefined,
          about: info.about ?? undefined,
          producer: info.producer ?? undefined,
          status: info.status ?? undefined,
          schema_version: info.schema_version ?? undefined,
          data_release: parseNumberMaybe(info.data_release),
        },
        data_dir: getDataDir(),
        artifacts_dir: getArtifactsDir(),
      };
    },
  },
  {
    name: PDG_FIND_PARTICLE,
    description:
      'Find particle candidates by name / MCID / PDG identifier (small result; supports pagination; local-only; requires `PDG_DB_PATH`).',
    exposure: 'standard',
    zodSchema: PdgFindParticleToolSchema,
    handler: async (params) => {
      const dbPath = requirePdgDbPathFromEnv();

      const limit = params.limit;
      const start = params.start;
      const case_sensitive = params.case_sensitive;

      if (params.name !== undefined) {
        const { normalized, changed } = normalizeParticleNameInput(params.name);
        const mode = params.match as NameMatchMode;
        const { candidates, has_more } = await findPdgParticlesByName(dbPath, normalized, {
          mode,
          case_sensitive,
          start,
          limit,
        });

        const disambiguation =
          candidates.length > 1
            ? 'Multiple candidates found; refine by using an exact charged name (e.g. "W+") or provide mcid/pdgid.'
            : null;

        return {
          query: { name: params.name, normalized_name: changed ? normalized : undefined, match: mode, case_sensitive },
          start,
          limit,
          has_more,
          candidates,
          disambiguation,
        };
      }

      const mcid = params.mcid ?? params.pdg_code;
      if (mcid !== undefined) {
        const { candidates, has_more } = await findPdgParticlesByMcid(dbPath, mcid, { start, limit });
        const disambiguation =
          candidates.length > 1 ? 'Multiple candidates found; refine by using a name or PDG identifier.' : null;
        return {
          query: { mcid },
          start,
          limit,
          has_more,
          candidates,
          disambiguation,
        };
      }

      const { candidates: direct, has_more: directHasMore } = await findPdgParticlesByPdgid(dbPath, params.pdgid!, {
        start,
        limit,
        case_sensitive,
      });
      if (direct.length > 0 || directHasMore) {
        const disambiguation =
          direct.length > 1 ? 'Multiple candidates found; refine by using an exact charged name or provide mcid.' : null;
        return {
          query: { pdgid: params.pdgid, case_sensitive },
          start,
          limit,
          has_more: directHasMore,
          candidates: direct,
          disambiguation,
        };
      }

      const row = await getPdgidRowByPdgid(dbPath, params.pdgid!, case_sensitive);
      const parent = row?.parent_pdgid;
      if (parent) {
        const { candidates, has_more } = await findPdgParticlesByPdgid(dbPath, parent, { start, limit, case_sensitive });
        const disambiguation =
          candidates.length > 1 ? 'Multiple candidates found; refine by using an exact charged name or provide mcid.' : null;
        return {
          query: { pdgid: params.pdgid, case_sensitive },
          normalized: { pdgid: parent },
          start,
          limit,
          has_more,
          candidates,
          disambiguation,
        };
      }

      return {
        query: { pdgid: params.pdgid, case_sensitive },
        start,
        limit,
        has_more: false,
        candidates: [],
        disambiguation: null,
      };
    },
  },
  {
    name: PDG_FIND_REFERENCE,
    description:
      'Find PDG references by DOI / INSPIRE recid / document id / title (small result; supports pagination; local-only; requires `PDG_DB_PATH`).',
    exposure: 'standard',
    zodSchema: PdgFindReferenceToolSchema,
    handler: async params => {
      const dbPath = requirePdgDbPathFromEnv();

      const query =
        params.doi ?? params.inspire_id ?? params.document_id ?? params.title ?? (() => {
          throw new Error('unreachable');
        })();
      const field = params.doi
        ? 'doi'
        : params.inspire_id
          ? 'inspire_id'
          : params.document_id
            ? 'document_id'
            : 'title';

      const { candidates, has_more } = await findPdgReferences(dbPath, field, query, {
        mode: params.match,
        case_sensitive: params.case_sensitive,
        start: params.start,
        limit: params.limit,
      });

      return {
        query: { field, value: query, match: params.match, case_sensitive: params.case_sensitive },
        start: params.start,
        limit: params.limit,
        has_more,
        references: candidates.map(r => ({
          ...r,
          inspire_lookup_by_id: toInspireLookupIdentifiers(r),
        })),
      };
    },
  },
  {
    name: PDG_GET_REFERENCE,
    description: 'Get a PDG reference record (small result; includes INSPIRE lookup identifiers; local-only; requires `PDG_DB_PATH`).',
    exposure: 'standard',
    zodSchema: PdgGetReferenceToolSchema,
    handler: async params => {
      const dbPath = requirePdgDbPathFromEnv();

      const ref = params.id
        ? await getPdgReferenceById(dbPath, params.id)
        : await getPdgReferenceByDocumentId(dbPath, params.document_id!, params.case_sensitive);

      if (!ref) {
        throw notFound('PDG reference not found', {
          id: params.id ?? null,
          document_id: params.document_id ?? null,
        });
      }

      return {
        reference: {
          ...ref,
          inspire_lookup_by_id: toInspireLookupIdentifiers(ref),
        },
        pdg_locator: { table: 'pdgreference', pdgreference_id: ref.id },
      };
    },
  },
  {
    name: PDG_GET_PROPERTY,
    description:
      'Get a high-frequency particle property (mass/width/lifetime) with uncertainties and PDG locator (local-only; requires `PDG_DB_PATH`).',
    exposure: 'standard',
    zodSchema: PdgGetPropertyToolSchema,
    handler: async (params) => {
      const dbPath = requirePdgDbPathFromEnv();

      const selector = params.particle;
      const resolved = await requireUniqueBaseParticle(dbPath, selector);
      const basePdgid = resolved.base_pdgid;
      const particle = resolved.particle;

      const dataType = params.property === 'mass' ? 'M' : params.property === 'width' ? 'G' : 'T';

      const info = await readPdgInfoMap(dbPath);
      const preferredEdition = params.edition ?? info.edition ?? undefined;

      const propertyRows = await sqlite3JsonQuery(
        dbPath,
        `
SELECT id, pdgid, description, data_type, flags, sort
FROM pdgid
WHERE parent_pdgid = ${sqlStringLiteral(basePdgid)}
  AND data_type = ${sqlStringLiteral(dataType)}
ORDER BY (flags LIKE 'D%') DESC, sort ASC, id ASC
LIMIT 10;
`.trim()
      );

      const props = propertyRows
        .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>) : null))
        .filter(Boolean)
        .map(r => ({
          id: typeof r!.id === 'number' ? r!.id : Number(r!.id),
          pdgid: String(r!.pdgid),
          description: r!.description === null || r!.description === undefined ? null : String(r!.description),
          data_type: r!.data_type === null || r!.data_type === undefined ? null : String(r!.data_type),
          flags: r!.flags === null || r!.flags === undefined ? null : String(r!.flags),
          sort: r!.sort === null || r!.sort === undefined ? null : Number(r!.sort),
        }))
        .filter(r => Number.isFinite(r.id) && typeof r.pdgid === 'string');

      if (props.length === 0) {
        if (params.property !== 'width' || !params.allow_derived) {
          throw notFound('Property not found for particle', { particle: basePdgid, property: params.property });
        }

        const lifetimeRows = await sqlite3JsonQuery(
          dbPath,
          `
SELECT id, pdgid, description, data_type, flags, sort
FROM pdgid
WHERE parent_pdgid = ${sqlStringLiteral(basePdgid)}
  AND data_type = 'T'
ORDER BY (flags LIKE 'D%') DESC, sort ASC, id ASC
LIMIT 10;
`.trim()
        );

        const lifetimes = lifetimeRows
          .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>) : null))
          .filter(Boolean)
          .map(r => ({
            id: typeof r!.id === 'number' ? r!.id : Number(r!.id),
            pdgid: String(r!.pdgid),
            description: r!.description === null || r!.description === undefined ? null : String(r!.description),
            data_type: r!.data_type === null || r!.data_type === undefined ? null : String(r!.data_type),
            flags: r!.flags === null || r!.flags === undefined ? null : String(r!.flags),
            sort: r!.sort === null || r!.sort === undefined ? null : Number(r!.sort),
          }))
          .filter(r => Number.isFinite(r.id) && typeof r.pdgid === 'string');

        if (lifetimes.length === 0) {
          throw notFound('Cannot derive width: lifetime not found for particle', { particle: basePdgid });
        }

        const lifetimeProp = lifetimes[0]!;

        const availableEditionsRows = await sqlite3JsonQuery(
          dbPath,
          `
SELECT DISTINCT edition
FROM pdgdata
WHERE pdgid_id = ${lifetimeProp.id}
  AND edition IS NOT NULL
ORDER BY edition DESC;
`.trim()
        );
        const availableEditions = availableEditionsRows
          .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>).edition : null))
          .map(v => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v)))
          .filter((v): v is string => typeof v === 'string' && v.length > 0);

        const chosenEdition = chooseEdition({
          preferredEdition,
          requestedEdition: params.edition ?? undefined,
          availableEditions,
          what: 'lifetime (for derived width)',
        });

        const editionWhere = chosenEdition ? `AND edition = ${sqlStringLiteral(chosenEdition)}` : '';
        const lifetimeDataRows = await sqlite3JsonQuery(
          dbPath,
          `
SELECT
  id,
  edition,
  value_type,
  in_summary_table,
  confidence_level,
  limit_type,
  comment,
  value,
  value_text,
  error_positive,
  error_negative,
  scale_factor,
  unit_text,
  display_value_text,
  display_power_of_ten,
  display_in_percent
FROM pdgdata
WHERE pdgid_id = ${lifetimeProp.id}
  ${editionWhere}
ORDER BY in_summary_table DESC, COALESCE(sort, 0) ASC, id ASC;
`.trim()
        );

        const lifetimeData = lifetimeDataRows
          .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>) : null))
          .filter(Boolean)
          .map(r => ({
            id: typeof r!.id === 'number' ? r!.id : Number(r!.id),
            edition: r!.edition === null || r!.edition === undefined ? null : String(r!.edition),
            value_type: r!.value_type === null || r!.value_type === undefined ? null : String(r!.value_type),
            in_summary_table: Boolean(r!.in_summary_table),
            confidence_level: r!.confidence_level === null || r!.confidence_level === undefined ? null : Number(r!.confidence_level),
            limit_type: r!.limit_type === null || r!.limit_type === undefined ? null : String(r!.limit_type),
            comment: r!.comment === null || r!.comment === undefined ? null : String(r!.comment),
            value: r!.value === null || r!.value === undefined ? null : Number(r!.value),
            value_text: r!.value_text === null || r!.value_text === undefined ? null : String(r!.value_text),
            error_positive: r!.error_positive === null || r!.error_positive === undefined ? null : Number(r!.error_positive),
            error_negative: r!.error_negative === null || r!.error_negative === undefined ? null : Number(r!.error_negative),
            scale_factor: r!.scale_factor === null || r!.scale_factor === undefined ? null : Number(r!.scale_factor),
            unit_text: r!.unit_text === null || r!.unit_text === undefined ? null : String(r!.unit_text),
            display_value_text: r!.display_value_text === null || r!.display_value_text === undefined ? null : String(r!.display_value_text),
            display_power_of_ten:
              r!.display_power_of_ten === null || r!.display_power_of_ten === undefined ? null : Number(r!.display_power_of_ten),
            display_in_percent: Boolean(r!.display_in_percent),
          }))
          .filter(r => Number.isFinite(r.id));

        if (lifetimeData.length === 0) {
          throw notFound('Cannot derive width: no lifetime pdgdata rows found', {
            pdgid_id: lifetimeProp.id,
            edition: chosenEdition ?? null,
          });
        }

        const lifetimeChosen = lifetimeData[0]!;
        if (lifetimeChosen.value === null || !Number.isFinite(lifetimeChosen.value)) {
          throw notFound('Cannot derive width: lifetime numeric value missing', {
            pdgid_id: lifetimeProp.id,
            pdgdata_id: lifetimeChosen.id,
          });
        }

        const derived = deriveWidthFromLifetime({
          lifetime_value: lifetimeChosen.value,
          lifetime_error_positive: lifetimeChosen.error_positive,
          lifetime_error_negative: lifetimeChosen.error_negative,
          lifetime_unit_text: lifetimeChosen.unit_text,
        });

        const derivedDisplayText = formatPdgDisplayText({
          display_value_text: derived.value.display_value_text,
          unit_text: derived.value.unit_text,
          display_power_of_ten: derived.value.display_power_of_ten,
          display_in_percent: derived.value.display_in_percent,
        });

        const lifetimeLocator = {
          table: 'pdgdata',
          pdgdata_id: lifetimeChosen.id,
          pdgid: lifetimeProp.pdgid,
          pdgid_id: lifetimeProp.id,
          edition: lifetimeChosen.edition ?? chosenEdition ?? null,
        };

        return {
          normalized: resolved.normalized ?? null,
          particle,
          property: {
            key: 'width',
            pdgid: null,
            pdgid_id: null,
            description: 'Derived from lifetime (mean life): Γ = ħ / τ',
            data_type: 'G',
            flags: null,
            derived: {
              kind: 'width_from_lifetime',
              formula: 'Gamma = ħ / tau',
              constants: derived.constants,
              from: {
                property: 'lifetime',
                pdgid: lifetimeProp.pdgid,
                pdgid_id: lifetimeProp.id,
                pdg_locator: lifetimeLocator,
              },
            },
          },
          edition: lifetimeChosen.edition ?? chosenEdition ?? null,
          value: {
            display_value_text: derived.value.display_value_text,
            display_text: derivedDisplayText,
            unit_text: derived.value.unit_text,
            value: derived.value.value,
            error_positive: derived.value.error_positive,
            error_negative: derived.value.error_negative,
            limit_type: null,
            limit_type_meaning: null,
            value_type: 'DERIVED',
            value_type_meaning: null,
            confidence_level: null,
            display_in_percent: derived.value.display_in_percent,
            display_power_of_ten: derived.value.display_power_of_ten,
          },
          pdg_locator: {
            table: 'derived(width_from_lifetime)',
            derived_from: lifetimeLocator,
          },
          alternatives: {
            property_pdgids: [],
            pdgdata_rows: 0,
          },
        };
      }

      const prop = props[0]!;

      const availableEditionsRows = await sqlite3JsonQuery(
        dbPath,
        `
SELECT DISTINCT edition
FROM pdgdata
WHERE pdgid_id = ${prop.id}
  AND edition IS NOT NULL
ORDER BY edition DESC;
`.trim()
      );
      const availableEditions = availableEditionsRows
        .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>).edition : null))
        .map(v => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v)))
        .filter((v): v is string => typeof v === 'string' && v.length > 0);

      const chosenEdition = chooseEdition({
        preferredEdition,
        requestedEdition: params.edition ?? undefined,
        availableEditions,
        what: 'this property',
      });

      const editionWhere = chosenEdition ? `AND edition = ${sqlStringLiteral(chosenEdition)}` : '';
      const dataRows = await sqlite3JsonQuery(
        dbPath,
        `
SELECT
  id,
  edition,
  value_type,
  in_summary_table,
  confidence_level,
  limit_type,
  comment,
  value,
  value_text,
  error_positive,
  error_negative,
  scale_factor,
  unit_text,
  display_value_text,
  display_power_of_ten,
  display_in_percent
FROM pdgdata
WHERE pdgid_id = ${prop.id}
  ${editionWhere}
ORDER BY in_summary_table DESC, COALESCE(sort, 0) ASC, id ASC;
`.trim()
      );

      const data = dataRows
        .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>) : null))
        .filter(Boolean)
        .map(r => ({
          id: typeof r!.id === 'number' ? r!.id : Number(r!.id),
          edition: r!.edition === null || r!.edition === undefined ? null : String(r!.edition),
          value_type: r!.value_type === null || r!.value_type === undefined ? null : String(r!.value_type),
          in_summary_table: Boolean(r!.in_summary_table),
          confidence_level: r!.confidence_level === null || r!.confidence_level === undefined ? null : Number(r!.confidence_level),
          limit_type: r!.limit_type === null || r!.limit_type === undefined ? null : String(r!.limit_type),
          comment: r!.comment === null || r!.comment === undefined ? null : String(r!.comment),
          value: r!.value === null || r!.value === undefined ? null : Number(r!.value),
          value_text: r!.value_text === null || r!.value_text === undefined ? null : String(r!.value_text),
          error_positive: r!.error_positive === null || r!.error_positive === undefined ? null : Number(r!.error_positive),
          error_negative: r!.error_negative === null || r!.error_negative === undefined ? null : Number(r!.error_negative),
          scale_factor: r!.scale_factor === null || r!.scale_factor === undefined ? null : Number(r!.scale_factor),
          unit_text: r!.unit_text === null || r!.unit_text === undefined ? null : String(r!.unit_text),
          display_value_text: r!.display_value_text === null || r!.display_value_text === undefined ? null : String(r!.display_value_text),
          display_power_of_ten:
            r!.display_power_of_ten === null || r!.display_power_of_ten === undefined ? null : Number(r!.display_power_of_ten),
          display_in_percent: Boolean(r!.display_in_percent),
        }))
        .filter(r => Number.isFinite(r.id));

      if (data.length === 0) {
        throw notFound('No pdgdata rows found for property', {
          pdgid_id: prop.id,
          edition: chosenEdition ?? null,
        });
      }

      const chosen = data[0]!;

      const docConditions: string[] = [];
      if (chosen.value_type) {
        docConditions.push(`(column_name='VALUE_TYPE' AND value=${sqlStringLiteral(chosen.value_type)})`);
      }
      if (chosen.limit_type) {
        docConditions.push(`(column_name='LIMIT_TYPE' AND value=${sqlStringLiteral(chosen.limit_type)})`);
      }

      const codeMeanings: { value_type: string | null; limit_type: string | null } = { value_type: null, limit_type: null };
      if (docConditions.length > 0) {
        const docRows = await sqlite3JsonQuery(
          dbPath,
          `
SELECT column_name, value, description
FROM pdgdoc
WHERE table_name='PDGDATA'
  AND (${docConditions.join(' OR ')});
`.trim()
        );

        for (const row of docRows) {
          if (row === null || typeof row !== 'object') continue;
          const r = row as Record<string, unknown>;
          const col = typeof r.column_name === 'string' ? r.column_name : String(r.column_name);
          const desc = typeof r.description === 'string' ? r.description : String(r.description);
          if (col === 'VALUE_TYPE') codeMeanings.value_type = desc;
          if (col === 'LIMIT_TYPE') codeMeanings.limit_type = desc;
        }
      }

      const pdg_locator = {
        table: 'pdgdata',
        pdgdata_id: chosen.id,
        pdgid: prop.pdgid,
        pdgid_id: prop.id,
        edition: chosen.edition ?? chosenEdition ?? null,
      };

      return {
        normalized: resolved.normalized ?? null,
        particle,
        property: {
          key: params.property,
          pdgid: prop.pdgid,
          pdgid_id: prop.id,
          description: prop.description,
          data_type: prop.data_type,
          flags: prop.flags,
        },
        edition: chosen.edition ?? chosenEdition ?? null,
        value: {
          display_value_text: chosen.display_value_text,
          display_text: formatPdgDisplayText({
            display_value_text: chosen.display_value_text,
            unit_text: chosen.unit_text,
            display_power_of_ten: chosen.display_power_of_ten,
            display_in_percent: chosen.display_in_percent,
          }),
          unit_text: chosen.unit_text,
          value: chosen.value,
          error_positive: chosen.error_positive,
          error_negative: chosen.error_negative,
          limit_type: chosen.limit_type,
          limit_type_meaning: codeMeanings.limit_type,
          value_type: chosen.value_type,
          value_type_meaning: codeMeanings.value_type,
          confidence_level: chosen.confidence_level,
          display_in_percent: chosen.display_in_percent,
          display_power_of_ten: chosen.display_power_of_ten,
        },
        pdg_locator,
        alternatives: {
          property_pdgids: props.slice(1).map(p => ({ pdgid: p.pdgid, pdgid_id: p.id, flags: p.flags })),
          pdgdata_rows: data.length,
        },
      };
    },
  },
  {
    name: PDG_GET,
    description: 'Get a PDG identifier object (writes a JSON artifact; returns URI + summary; local-only; requires `PDG_DB_PATH`).',
    exposure: 'standard',
    zodSchema: PdgGetToolSchema,
    handler: async (params) => {
      const dbPath = requirePdgDbPathFromEnv();

      const [row, info] = await Promise.all([
        getPdgidRowByPdgid(dbPath, params.pdgid, false),
        readPdgInfoMap(dbPath),
      ]);
      if (!row) {
        throw notFound('PDG identifier not found', { pdgid: params.pdgid });
      }

      const preferredEdition = params.edition ?? info.edition ?? undefined;

      const availableEditionsRows = await sqlite3JsonQuery(
        dbPath,
        `
SELECT DISTINCT edition
FROM pdgdata
WHERE pdgid_id = ${row.id}
  AND edition IS NOT NULL
ORDER BY edition DESC;
`.trim()
      );
      const availableEditions = availableEditionsRows
        .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>).edition : null))
        .map(v => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v)))
        .filter((v): v is string => typeof v === 'string' && v.length > 0);

      const chosenEdition = chooseEdition({
        preferredEdition,
        requestedEdition: params.edition ?? undefined,
        availableEditions,
        what: 'this PDG identifier',
      });

      const editionWhere = chosenEdition ? `AND edition = ${sqlStringLiteral(chosenEdition)}` : '';
      const [dataRows, decayRows, childRows, childCountRows] = await Promise.all([
        sqlite3JsonQuery(
          dbPath,
          `
SELECT
  id,
  edition,
  value_type,
  in_summary_table,
  confidence_level,
  limit_type,
  comment,
  value,
  value_text,
  error_positive,
  error_negative,
  scale_factor,
  unit_text,
  display_value_text,
  display_power_of_ten,
  display_in_percent,
  sort
FROM pdgdata
WHERE pdgid_id = ${row.id}
  ${editionWhere}
ORDER BY in_summary_table DESC, COALESCE(sort, 0) ASC, id ASC;
`.trim()
        ),
        sqlite3JsonQuery(
          dbPath,
          `
SELECT name, is_outgoing, multiplier, subdecay_id, sort
FROM pdgdecay
WHERE pdgid_id = ${row.id}
ORDER BY sort ASC;
`.trim()
        ),
        sqlite3JsonQuery(
          dbPath,
          `
SELECT id, pdgid, description, data_type, flags, sort
FROM pdgid
WHERE parent_pdgid = ${sqlStringLiteral(row.pdgid)}
ORDER BY sort ASC, id ASC
LIMIT 50;
`.trim()
        ),
        sqlite3JsonQuery(
          dbPath,
          `
SELECT COUNT(*) AS cnt
FROM pdgid
WHERE parent_pdgid = ${sqlStringLiteral(row.pdgid)};
`.trim()
        ),
      ]);
      const childCount = (() => {
        const r = childCountRows[0];
        if (r && typeof r === 'object') {
          const v = (r as Record<string, unknown>).cnt;
          if (typeof v === 'number') return v;
          if (typeof v === 'string') return Number(v);
        }
        return 0;
      })();

      const detail = {
        pdgid: row,
        edition: chosenEdition ?? null,
        pdgdata_rows: dataRows,
        pdgdecay_rows: decayRows,
        children: {
          count: childCount,
          sample: childRows,
        },
      };

      const artifactName =
        params.artifact_name ?? defaultArtifactName('pdg_get', `${row.pdgid}__${chosenEdition ?? 'all'}`, 'json');
      const artifact = writeJsonArtifact(artifactName, detail);

      const summaryRow = (() => {
        const r = dataRows[0];
        if (!r || typeof r !== 'object') return null;
        const obj = r as Record<string, unknown>;
        return {
          display_value_text: typeof obj.display_value_text === 'string' ? obj.display_value_text : null,
          unit_text: typeof obj.unit_text === 'string' ? obj.unit_text : null,
          value_type: typeof obj.value_type === 'string' ? obj.value_type : null,
          limit_type: typeof obj.limit_type === 'string' ? obj.limit_type : null,
        };
      })();

      return {
        uri: artifact.uri,
        summary: {
          pdgid: row.pdgid,
          pdgid_id: row.id,
          description: row.description,
          data_type: row.data_type,
          flags: row.flags,
          edition: chosenEdition ?? null,
          pdgdata_rows: dataRows.length,
          has_decay: decayRows.length > 0,
          child_count: childCount,
          top_value: summaryRow,
        },
        artifact: {
          name: artifact.name,
          mimeType: artifact.mimeType,
          size_bytes: artifact.size_bytes,
          sha256: artifact.sha256,
        },
      };
    },
  },
  {
    name: PDG_GET_DECAYS,
    description: 'List decay modes for a particle (writes JSONL artifact; returns URI + summary; local-only; requires `PDG_DB_PATH`).',
    exposure: 'standard',
    zodSchema: PdgGetDecaysToolSchema,
    handler: async (params) => {
      const dbPath = requirePdgDbPathFromEnv();

      const selector = params.particle;
      const [resolved, info] = await Promise.all([requireUniqueBaseParticle(dbPath, selector), readPdgInfoMap(dbPath)]);
      const basePdgid = resolved.base_pdgid;

      const preferredEdition = params.edition ?? info.edition ?? undefined;

      const availableEditionsRows = await sqlite3JsonQuery(
        dbPath,
        `
SELECT DISTINCT d.edition AS edition
FROM pdgid g
JOIN pdgdata d ON d.pdgid_id = g.id
WHERE g.parent_pdgid = ${sqlStringLiteral(basePdgid)}
  AND g.data_type = 'BFX'
  AND d.edition IS NOT NULL
ORDER BY d.edition DESC;
`.trim()
      );
      const availableEditions = availableEditionsRows
        .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>).edition : null))
        .map(v => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v)))
        .filter((v): v is string => typeof v === 'string' && v.length > 0);

      const chosenEdition = chooseEdition({
        preferredEdition,
        requestedEdition: params.edition ?? undefined,
        availableEditions,
        what: 'these decays',
      });

      const editionClause = chosenEdition ? `AND d2.edition = ${sqlStringLiteral(chosenEdition)}` : '';

      const sql = `
SELECT
  g.id AS pdgid_id,
  g.pdgid AS pdgid,
  g.description AS description,
  g.data_type AS data_type,
  g.flags AS flags,
  d.id AS pdgdata_id,
  d.edition AS edition,
  d.value_type AS value_type,
  d.limit_type AS limit_type,
  d.value AS value,
  d.error_positive AS error_positive,
  d.error_negative AS error_negative,
  d.unit_text AS unit_text,
  d.display_value_text AS display_value_text,
  d.display_power_of_ten AS display_power_of_ten,
  d.display_in_percent AS display_in_percent
FROM pdgid g
LEFT JOIN pdgdata d ON d.id = (
  SELECT d2.id
  FROM pdgdata d2
  WHERE d2.pdgid_id = g.id
    ${editionClause}
  ORDER BY d2.in_summary_table DESC, COALESCE(d2.sort, 0) ASC, d2.id ASC
  LIMIT 1
)
WHERE g.parent_pdgid = ${sqlStringLiteral(basePdgid)}
  AND g.data_type = 'BFX'
ORDER BY g.sort ASC, g.id ASC
LIMIT ${params.limit + 1} OFFSET ${params.start};
`.trim();

      const decayEntries = await sqlite3JsonQuery(dbPath, sql);
      const has_more = decayEntries.length > params.limit;
      const page = (has_more ? decayEntries.slice(0, params.limit) : decayEntries).filter(
        r => r && typeof r === 'object'
      ) as Array<Record<string, unknown>>;

      const ids = page
        .map(r => (typeof r.pdgid_id === 'number' ? r.pdgid_id : Number(r.pdgid_id)))
        .filter(n => Number.isFinite(n));

      const decayParts =
        ids.length === 0
        ? []
        : await sqlite3JsonQuery(
          dbPath,
          `
SELECT pdgid_id, name, is_outgoing, multiplier, subdecay_id, sort
FROM pdgdecay
WHERE pdgid_id IN (${ids.join(',')})
ORDER BY pdgid_id ASC, sort ASC;
`.trim()
        );

      const partsById = new Map<number, Array<Record<string, unknown>>>();
      for (const row of decayParts) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const id = typeof r.pdgid_id === 'number' ? r.pdgid_id : Number(r.pdgid_id);
        if (!Number.isFinite(id)) continue;
        const list = partsById.get(id) ?? [];
        list.push(r);
        partsById.set(id, list);
      }

      const lines = page.map(r => {
        const pdgid_id = typeof r.pdgid_id === 'number' ? r.pdgid_id : Number(r.pdgid_id);
        const parts = Number.isFinite(pdgid_id) ? (partsById.get(pdgid_id) ?? []) : [];

        const incoming = parts
          .filter(p => !Boolean(p.is_outgoing))
          .map(p => ({
            name: String(p.name),
            multiplier: typeof p.multiplier === 'number' ? p.multiplier : Number(p.multiplier),
            subdecay_id: p.subdecay_id === null || p.subdecay_id === undefined ? null : Number(p.subdecay_id),
          }));
        const outgoing = parts
          .filter(p => Boolean(p.is_outgoing))
          .map(p => ({
            name: String(p.name),
            multiplier: typeof p.multiplier === 'number' ? p.multiplier : Number(p.multiplier),
            subdecay_id: p.subdecay_id === null || p.subdecay_id === undefined ? null : Number(p.subdecay_id),
          }));

        const incomingStr = incoming.length > 0 ? incoming.map(x => (x.multiplier > 1 ? `${x.multiplier}*${x.name}` : x.name)).join(' + ') : '';
        const outgoingStr = outgoing.length > 0 ? outgoing.map(x => (x.multiplier > 1 ? `${x.multiplier}*${x.name}` : x.name)).join(' + ') : '';

        return {
          pdgid_id,
          pdgid: String(r.pdgid),
          description: r.description === null || r.description === undefined ? null : String(r.description),
          data_type: r.data_type === null || r.data_type === undefined ? null : String(r.data_type),
          flags: r.flags === null || r.flags === undefined ? null : String(r.flags),
          decay: incomingStr && outgoingStr ? `${incomingStr} -> ${outgoingStr}` : null,
          incoming,
          outgoing,
          branching: {
            pdgdata_id: r.pdgdata_id === null || r.pdgdata_id === undefined ? null : Number(r.pdgdata_id),
            edition: r.edition === null || r.edition === undefined ? null : String(r.edition),
            display_value_text: r.display_value_text === null || r.display_value_text === undefined ? null : String(r.display_value_text),
            display_text: formatPdgDisplayText({
              display_value_text:
                r.display_value_text === null || r.display_value_text === undefined ? null : String(r.display_value_text),
              unit_text: r.unit_text === null || r.unit_text === undefined ? null : String(r.unit_text),
              display_power_of_ten:
                r.display_power_of_ten === null || r.display_power_of_ten === undefined ? null : Number(r.display_power_of_ten),
              display_in_percent: Boolean(r.display_in_percent),
            }),
            unit_text: r.unit_text === null || r.unit_text === undefined ? null : String(r.unit_text),
            value: r.value === null || r.value === undefined ? null : Number(r.value),
            error_positive: r.error_positive === null || r.error_positive === undefined ? null : Number(r.error_positive),
            error_negative: r.error_negative === null || r.error_negative === undefined ? null : Number(r.error_negative),
            value_type: r.value_type === null || r.value_type === undefined ? null : String(r.value_type),
            limit_type: r.limit_type === null || r.limit_type === undefined ? null : String(r.limit_type),
            display_in_percent: Boolean(r.display_in_percent),
            display_power_of_ten:
              r.display_power_of_ten === null || r.display_power_of_ten === undefined ? null : Number(r.display_power_of_ten),
          },
          pdg_locator: {
            pdgid: String(r.pdgid),
            pdgid_id,
            pdgdata_id: r.pdgdata_id === null || r.pdgdata_id === undefined ? null : Number(r.pdgdata_id),
            table: 'pdgdecay/pdgdata',
          },
        };
      });

      const artifactName =
        params.artifact_name
        ?? defaultArtifactName('pdg_decays', `${basePdgid}__${chosenEdition ?? 'all'}__${params.start}__${params.limit}`, 'jsonl');
      const artifact = writeJsonlArtifact(artifactName, lines);

      return {
        uri: artifact.uri,
        summary: {
          normalized: resolved.normalized ?? null,
          particle: {
            pdgid: basePdgid,
            variants: resolved.particle.variants.map(v => ({ name: v.name, mcid: v.mcid, charge: v.charge })),
          },
          edition: chosenEdition ?? null,
          start: params.start,
          limit: params.limit,
          has_more,
          decays: lines.length,
          preview: lines.slice(0, 3).map(d => ({
            pdgid: d.pdgid,
            decay: d.decay,
            display_value_text: d.branching.display_value_text,
            display_text: d.branching.display_text,
          })),
        },
        artifact: {
          name: artifact.name,
          mimeType: artifact.mimeType,
          size_bytes: artifact.size_bytes,
          sha256: artifact.sha256,
          rows: artifact.rows,
        },
      };
    },
  },
  {
    name: PDG_GET_MEASUREMENTS,
    description:
      'List PDG measurements for an identifier (writes JSONL artifact; includes references/values/footnotes; local-only; requires `PDG_DB_PATH`). Can be called with pdgid, particle selector, or property_pdgid directly. ' +
      'CRITICAL: If the result has kind="series_options" or stop_here=true, you MUST STOP querying and select one series using property_pdgid or data_type from example_next_calls. ' +
      'Do NOT call again with the same particle/pdgid - this will cause infinite loops. ' +
      'If has_more=true, use start parameter to paginate (e.g., start=previous_start+limit).',
    exposure: 'standard',
    zodSchema: PdgGetMeasurementsToolSchema,
    handler: async params => {
      const dbPath = requirePdgDbPathFromEnv();

      type SeriesCandidate = {
        pdgid: string;
        pdgid_id: number;
        parent_pdgid: string | null;
        description: string | null;
        data_type: string | null;
        flags: string | null;
        sort: number | null;
        measurement_count: number;
      };

      const isNumericId = (s: string): boolean => /^\d+$/.test(s.trim());
      const toNumber = (v: unknown): number | null => {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && v.trim().length > 0) {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        }
        return null;
      };
      const toStringOrNull = (v: unknown): string | null => {
        if (typeof v === 'string') return v;
        if (v === null || v === undefined) return null;
        return String(v);
      };

      const listMeasurementSeries = async (basePdgid: string): Promise<SeriesCandidate[]> => {
        const rows = await sqlite3JsonQuery(
          dbPath,
          `
SELECT
  g.id AS pdgid_id,
  g.pdgid AS pdgid,
  g.parent_pdgid AS parent_pdgid,
  g.description AS description,
  g.data_type AS data_type,
  g.flags AS flags,
  g.sort AS sort,
  (SELECT COUNT(*) FROM pdgmeasurement m WHERE m.pdgid_id = g.id) AS measurement_count
FROM pdgid g
WHERE g.parent_pdgid = ${sqlStringLiteral(basePdgid)}
ORDER BY measurement_count DESC, (g.flags LIKE 'D%') DESC, COALESCE(g.sort, 0) ASC, g.id ASC
LIMIT 500;
`.trim()
        );

        const parsed: SeriesCandidate[] = [];
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          const r = row as Record<string, unknown>;
          const id = toNumber(r.pdgid_id);
          const pdgid = toStringOrNull(r.pdgid);
          if (id === null || pdgid === null) continue;
          parsed.push({
            pdgid,
            pdgid_id: id,
            parent_pdgid: toStringOrNull(r.parent_pdgid),
            description: toStringOrNull(r.description),
            data_type: toStringOrNull(r.data_type),
            flags: toStringOrNull(r.flags),
            sort: toNumber(r.sort),
            measurement_count: toNumber(r.measurement_count) ?? 0,
          });
        }
        return parsed;
      };

      const resolveFromBaseParticle = async (
        basePdgid: string,
        overrides?: Partial<Pick<typeof params, 'property_pdgid' | 'data_type'>>
      ): Promise<{ target?: SeriesCandidate; series: SeriesCandidate[] }> => {
        const series = await listMeasurementSeries(basePdgid);

        const matchesDataType = (s: SeriesCandidate): boolean => {
          const dtRaw =
            overrides && Object.prototype.hasOwnProperty.call(overrides, 'data_type') ? overrides.data_type : params.data_type;
          if (!dtRaw) return true;
          const dt = dtRaw.trim();
          if (dt.length === 0) return true;
          return (s.data_type ?? '').toLowerCase() === dt.toLowerCase();
        };

        const propertyNeedle =
          overrides && Object.prototype.hasOwnProperty.call(overrides, 'property_pdgid') ? overrides.property_pdgid : params.property_pdgid;
        if (propertyNeedle) {
          const needle = propertyNeedle.trim();
          let match: SeriesCandidate | undefined;
          if (params.case_sensitive) {
            match = series.find(s => s.pdgid === needle);
          } else {
            match = series.find(s => s.pdgid === needle) ?? series.find(s => s.pdgid.toLowerCase() === needle.toLowerCase());
          }
          if (!match) {
            const levenshtein = (a: string, b: string): number => {
              if (a === b) return 0;
              if (a.length === 0) return b.length;
              if (b.length === 0) return a.length;

              const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
              const curr = new Array<number>(b.length + 1);
              for (let i = 1; i <= a.length; i++) {
                curr[0] = i;
                const ac = a.charCodeAt(i - 1);
                for (let j = 1; j <= b.length; j++) {
                  const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
                  curr[j] = Math.min(prev[j] + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
                }
                for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
              }
              return prev[b.length]!;
            };

            const needleLc = needle.toLowerCase();
            const closest = series
              .map(s => {
                const pdgidLc = s.pdgid.toLowerCase();
                const includes = pdgidLc.includes(needleLc) || needleLc.includes(pdgidLc);
                const distance = levenshtein(needleLc, pdgidLc);
                return { pdgid: s.pdgid, score: includes ? distance - 0.5 : distance };
              })
              .sort((a, b) => a.score - b.score)
              .filter(c => c.score <= 3 || c.pdgid.toLowerCase().includes(needleLc) || needleLc.includes(c.pdgid.toLowerCase()))
              .slice(0, 3)
              .map(c => c.pdgid);

            const looksLikePdgid = /^[A-Za-z]\d{3}([A-Za-z]\d*)?$/.test(needle);
            const pdgidDirectHint = looksLikePdgid
              ? "Did you mean to use this as 'pdgid' directly instead of 'property_pdgid'?"
              : null;
            const messageParts = [
              'property_pdgid not found under particle',
              closest.length > 0 ? `Closest matches: ${closest.join(', ')}` : null,
              pdgidDirectHint,
            ].filter(Boolean);

            throw invalidParams(messageParts.join(' '), {
              base_pdgid: basePdgid,
              property_pdgid: propertyNeedle,
              suggestion: closest.length > 0 ? closest : pdgidDirectHint ?? undefined,
              series: series.slice(0, 50).map(s => ({
                pdgid: s.pdgid,
                data_type: s.data_type,
                flags: s.flags,
                measurement_count: s.measurement_count,
                description: s.description,
              })),
            });
          }
          return { target: match, series };
        }

        const dataType =
          overrides && Object.prototype.hasOwnProperty.call(overrides, 'data_type') ? overrides.data_type : params.data_type;
        if (dataType) {
          const filtered = series.filter(matchesDataType);
          if (filtered.length === 1) return { target: filtered[0], series };
          if (filtered.length === 0) {
            throw invalidParams('No PDG identifiers match data_type under particle', {
              base_pdgid: basePdgid,
              data_type: dataType,
              available_data_types: Array.from(new Set(series.map(s => s.data_type).filter(Boolean))).sort(),
            });
          }
          throw invalidParams('Ambiguous data_type under particle; choose property_pdgid', {
            base_pdgid: basePdgid,
            data_type: dataType,
            candidates: filtered.slice(0, 50).map(s => ({
              pdgid: s.pdgid,
              data_type: s.data_type,
              flags: s.flags,
              measurement_count: s.measurement_count,
              description: s.description,
            })),
          });
        }

        const withMeasurements = series.filter(s => s.measurement_count > 0);
        if (withMeasurements.length === 1) return { target: withMeasurements[0], series };
        return { series };
      };

      const resolvedParticleContext = await (async (): Promise<
        | { kind: 'identifier'; pdgidRow: NonNullable<Awaited<ReturnType<typeof getPdgidRowByPdgid>>> }
        | { kind: 'series_options'; base_pdgid: string; normalized?: { pdgid?: string; name?: string } | null; particle?: unknown; series: SeriesCandidate[] }
      > => {
        if (params.property_pdgid && !params.pdgid && !params.particle) {
          const direct = await getPdgidRowByPdgid(dbPath, params.property_pdgid, params.case_sensitive);
          if (!direct) {
            throw notFound('PDG identifier not found', {
              pdgid: params.property_pdgid,
              suggestion: `Did you mean to use pdgid: "${params.property_pdgid}" instead?`,
            });
          }
          if (direct.data_type !== 'PART') {
            return { kind: 'identifier', pdgidRow: direct };
          }

          const basePdgid = direct.pdgid;
          const picked = await resolveFromBaseParticle(basePdgid, { property_pdgid: undefined });
          if (!picked.target) {
            return {
              kind: 'series_options',
              base_pdgid: basePdgid,
              normalized: null,
              particle: null,
              series: picked.series,
            };
          }
          const pdgidRow = await getPdgidRowByPdgid(dbPath, picked.target.pdgid, false);
          if (!pdgidRow) {
            throw notFound('PDG identifier not found', { pdgid: picked.target.pdgid });
          }
          return { kind: 'identifier', pdgidRow };
        }

        if (params.particle) {
          const resolved = await requireUniqueBaseParticle(dbPath, params.particle);
          const base = resolved.base_pdgid;
          const picked = await resolveFromBaseParticle(base);
          if (!picked.target) {
            return {
              kind: 'series_options',
              base_pdgid: base,
              normalized: resolved.normalized ?? null,
              particle: resolved.particle,
              series: picked.series,
            };
          }

          const pdgidRow = await getPdgidRowByPdgid(dbPath, picked.target.pdgid, false);
          if (!pdgidRow) {
            throw notFound('PDG identifier not found', { pdgid: picked.target.pdgid });
          }
          return { kind: 'identifier', pdgidRow };
        }

        const raw = params.pdgid ?? '';
        const direct = await getPdgidRowByPdgid(dbPath, raw, params.case_sensitive);
        if (direct && direct.data_type !== 'PART') {
          return { kind: 'identifier', pdgidRow: direct };
        }

        const basePdgid = direct?.data_type === 'PART' ? direct.pdgid : null;
        if (basePdgid) {
          const picked = await resolveFromBaseParticle(basePdgid);
          if (!picked.target) {
            return {
              kind: 'series_options',
              base_pdgid: basePdgid,
              normalized: null,
              particle: null,
              series: picked.series,
            };
          }
          const pdgidRow = await getPdgidRowByPdgid(dbPath, picked.target.pdgid, false);
          if (!pdgidRow) {
            throw notFound('PDG identifier not found', { pdgid: picked.target.pdgid });
          }
          return { kind: 'identifier', pdgidRow };
        }

        if (isNumericId(raw)) {
          const mcid = Number(raw.trim());
          const resolved = await requireUniqueBaseParticle(dbPath, { mcid, case_sensitive: false });
          const base = resolved.base_pdgid;
          const picked = await resolveFromBaseParticle(base);
          if (!picked.target) {
            return {
              kind: 'series_options',
              base_pdgid: base,
              normalized: resolved.normalized ?? null,
              particle: resolved.particle,
              series: picked.series,
            };
          }

          const pdgidRow = await getPdgidRowByPdgid(dbPath, picked.target.pdgid, false);
          if (!pdgidRow) {
            throw notFound('PDG identifier not found', { pdgid: picked.target.pdgid });
          }
          return { kind: 'identifier', pdgidRow };
        }

        throw notFound('PDG identifier not found', { pdgid: raw });
      })();

      if (resolvedParticleContext.kind === 'series_options') {
        const seriesWithMeasurements = resolvedParticleContext.series
          .filter(s => s.measurement_count > 0)
          .slice(0, 100)
          .map(s => ({
            pdgid: s.pdgid,
            pdgid_id: s.pdgid_id,
            data_type: s.data_type,
            flags: s.flags,
            description: s.description,
            measurement_count: s.measurement_count,
          }));

        const detail = {
          kind: 'measurement_series_options' as const,
          base_pdgid: resolvedParticleContext.base_pdgid,
          normalized: resolvedParticleContext.normalized ?? null,
          particle: resolvedParticleContext.particle ?? null,
          message:
            seriesWithMeasurements.length > 0
              ? 'Multiple measurement series found under this particle; choose one via property_pdgid or data_type.'
              : 'No measurement series found under this particle.',
          series: seriesWithMeasurements,
        };

        const artifactName =
          params.artifact_name
            ? params.artifact_name.replace(/\.jsonl$/i, '.json')
            : defaultArtifactName('pdg_measurement_series', `${resolvedParticleContext.base_pdgid}`, 'json');
        const artifact = writeJsonArtifact(artifactName, detail);

        const exampleParticleSelector = (() => {
          const normalized = resolvedParticleContext.normalized ?? null;
          if (normalized?.name && normalized.name.trim().length > 0) return { name: normalized.name };
          if (normalized?.pdgid && normalized.pdgid.trim().length > 0) return { pdgid: normalized.pdgid };

          const p = resolvedParticleContext.particle;
          if (p && typeof p === 'object') {
            const maybe = p as { pdgid?: unknown; variants?: unknown };
            const variants = Array.isArray(maybe.variants) ? maybe.variants : null;
            if (variants) {
              for (const v of variants) {
                if (!v || typeof v !== 'object') continue;
                const name = (v as { name?: unknown }).name;
                if (typeof name === 'string' && name.trim().length > 0) return { name };
              }
            }
            if (typeof maybe.pdgid === 'string' && maybe.pdgid.trim().length) return { pdgid: maybe.pdgid };
          }

          return { pdgid: resolvedParticleContext.base_pdgid };
        })();

        return {
          uri: artifact.uri,
          summary: {
            kind: 'series_options' as const,
            requires_selection: true,
            stop_here: true,
            base_pdgid: resolvedParticleContext.base_pdgid,
            series: seriesWithMeasurements.length,
            hint:
              seriesWithMeasurements.length > 0
                ? 'STOP: Multiple measurement series found. You MUST choose ONE series before continuing. ' +
                  'Do NOT call pdg_get_measurements again with the same particle/pdgid - instead, use one of the example_next_calls below with property_pdgid or data_type to select a specific series.'
                : 'This particle has no measurement series in pdgmeasurement.',
            example_next_calls: [
              { particle: exampleParticleSelector, data_type: 'T' },
              { particle: exampleParticleSelector, property_pdgid: seriesWithMeasurements[0]?.pdgid ?? null },
              { pdgid: resolvedParticleContext.base_pdgid, data_type: 'T' },
            ],
          },
          artifact: {
            name: artifact.name,
            mimeType: artifact.mimeType,
            size_bytes: artifact.size_bytes,
            sha256: artifact.sha256,
          },
        };
      }

      const pdgidRow = resolvedParticleContext.pdgidRow;

      const sql = `
SELECT
  id,
  pdgid_id,
  pdgid,
  pdgreference_id,
  event_count,
  confidence_level,
  place,
  technique,
  charge,
  changebar,
  comment,
  sort
FROM pdgmeasurement
WHERE pdgid_id = ${pdgidRow.id}
ORDER BY sort ASC, id ASC
LIMIT ${params.limit + 1} OFFSET ${params.start};
`.trim();

      const measurementRows = await sqlite3JsonQuery(dbPath, sql);
      const has_more = measurementRows.length > params.limit;
      const page = (has_more ? measurementRows.slice(0, params.limit) : measurementRows).filter(
        r => r && typeof r === 'object'
      ) as Array<Record<string, unknown>>;

      const measurementIds = page
        .map(r => (typeof r.id === 'number' ? r.id : Number(r.id)))
        .filter(n => Number.isFinite(n) && n > 0);

      const referenceIds = params.include_reference
        ? page
          .map(r => (typeof r.pdgreference_id === 'number' ? r.pdgreference_id : Number(r.pdgreference_id)))
          .filter(n => Number.isFinite(n) && n > 0)
        : [];

      const [valuesRows, footnoteRows, referencesById] = await Promise.all([
        params.include_values && measurementIds.length > 0
          ? sqlite3JsonQuery(
            dbPath,
            `
SELECT
  id,
  pdgmeasurement_id,
  column_name,
  value_text,
  unit_text,
  display_value_text,
  display_power_of_ten,
  display_in_percent,
  limit_type,
  used_in_average,
  used_in_fit,
  value,
  error_positive,
  error_negative,
  stat_error_positive,
  stat_error_negative,
  syst_error_positive,
  syst_error_negative,
  sort
FROM pdgmeasurement_values
WHERE pdgmeasurement_id IN (${measurementIds.join(',')})
ORDER BY pdgmeasurement_id ASC, COALESCE(sort, 0) ASC, id ASC;
`.trim()
          )
          : [],
        params.include_footnotes && measurementIds.length > 0
          ? sqlite3JsonQuery(
            dbPath,
            `
SELECT
  mf.pdgmeasurement_id AS pdgmeasurement_id,
  f.id AS pdgfootnote_id,
  f.pdgid AS pdgid,
  f.text AS text,
  f.footnote_index AS footnote_index,
  f.changebar AS changebar
FROM pdgmeasurement_footnote mf
JOIN pdgfootnote f ON f.id = mf.pdgfootnote_id
WHERE mf.pdgmeasurement_id IN (${measurementIds.join(',')})
ORDER BY mf.pdgmeasurement_id ASC, COALESCE(f.footnote_index, 0) ASC, f.id ASC;
`.trim()
          )
          : [],
        params.include_reference ? getPdgReferencesByIds(dbPath, referenceIds) : Promise.resolve(new Map()),
      ]);

      const valuesByMeasurementId = new Map<number, Array<Record<string, unknown>>>();
      for (const row of valuesRows) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const mid = typeof r.pdgmeasurement_id === 'number' ? r.pdgmeasurement_id : Number(r.pdgmeasurement_id);
        if (!Number.isFinite(mid)) continue;
        const list = valuesByMeasurementId.get(mid) ?? [];
        list.push(r);
        valuesByMeasurementId.set(mid, list);
      }

      const footnotesByMeasurementId = new Map<number, Array<Record<string, unknown>>>();
      for (const row of footnoteRows) {
        if (!row || typeof row !== 'object') continue;
        const r = row as Record<string, unknown>;
        const mid = typeof r.pdgmeasurement_id === 'number' ? r.pdgmeasurement_id : Number(r.pdgmeasurement_id);
        if (!Number.isFinite(mid)) continue;
        const list = footnotesByMeasurementId.get(mid) ?? [];
        list.push(r);
        footnotesByMeasurementId.set(mid, list);
      }

      const lines = page.map(m => {
        const measurement_id = typeof m.id === 'number' ? m.id : Number(m.id);
        const reference_id = typeof m.pdgreference_id === 'number' ? m.pdgreference_id : Number(m.pdgreference_id);

        const reference = params.include_reference && Number.isFinite(reference_id) ? referencesById.get(reference_id) : undefined;
        const valuesRaw =
          params.include_values && Number.isFinite(measurement_id) ? (valuesByMeasurementId.get(measurement_id) ?? []) : [];
        const footnotesRaw =
          params.include_footnotes && Number.isFinite(measurement_id) ? (footnotesByMeasurementId.get(measurement_id) ?? []) : [];

        const values = valuesRaw.map(v => {
          const display_value_text = v.display_value_text === null || v.display_value_text === undefined ? null : String(v.display_value_text);
          const unit_text = v.unit_text === null || v.unit_text === undefined ? null : String(v.unit_text);
          const display_power_of_ten =
            v.display_power_of_ten === null || v.display_power_of_ten === undefined ? null : Number(v.display_power_of_ten);
          const display_in_percent = Boolean(v.display_in_percent);

          return {
            id: v.id === null || v.id === undefined ? null : Number(v.id),
            column_name: v.column_name === null || v.column_name === undefined ? null : String(v.column_name),
            value_text: v.value_text === null || v.value_text === undefined ? null : String(v.value_text),
            unit_text,
            display_value_text,
            display_text: formatPdgDisplayText({
              display_value_text,
              unit_text,
              display_power_of_ten,
              display_in_percent,
            }),
            display_power_of_ten,
            display_in_percent,
            limit_type: v.limit_type === null || v.limit_type === undefined ? null : String(v.limit_type),
            used_in_average: Boolean(v.used_in_average),
            used_in_fit: Boolean(v.used_in_fit),
            value: v.value === null || v.value === undefined ? null : Number(v.value),
            error_positive: v.error_positive === null || v.error_positive === undefined ? null : Number(v.error_positive),
            error_negative: v.error_negative === null || v.error_negative === undefined ? null : Number(v.error_negative),
            stat_error_positive:
              v.stat_error_positive === null || v.stat_error_positive === undefined ? null : Number(v.stat_error_positive),
            stat_error_negative:
              v.stat_error_negative === null || v.stat_error_negative === undefined ? null : Number(v.stat_error_negative),
            syst_error_positive:
              v.syst_error_positive === null || v.syst_error_positive === undefined ? null : Number(v.syst_error_positive),
            syst_error_negative:
              v.syst_error_negative === null || v.syst_error_negative === undefined ? null : Number(v.syst_error_negative),
          };
        });

        const footnotes = footnotesRaw.map(f => ({
          id: f.pdgfootnote_id === null || f.pdgfootnote_id === undefined ? null : Number(f.pdgfootnote_id),
          pdgid: f.pdgid === null || f.pdgid === undefined ? null : String(f.pdgid),
          footnote_index: f.footnote_index === null || f.footnote_index === undefined ? null : Number(f.footnote_index),
          text: f.text === null || f.text === undefined ? null : String(f.text),
          changebar: Boolean(f.changebar),
        }));

        return {
          pdg_locator: {
            table: 'pdgmeasurement',
            pdgmeasurement_id: Number.isFinite(measurement_id) ? measurement_id : null,
            pdgid: pdgidRow.pdgid,
            pdgid_id: pdgidRow.id,
          },
          measurement: {
            id: Number.isFinite(measurement_id) ? measurement_id : null,
            pdgreference_id: Number.isFinite(reference_id) ? reference_id : null,
            event_count: m.event_count === null || m.event_count === undefined ? null : String(m.event_count),
            confidence_level:
              m.confidence_level === null || m.confidence_level === undefined ? null : Number(m.confidence_level),
            place: m.place === null || m.place === undefined ? null : String(m.place),
            technique: m.technique === null || m.technique === undefined ? null : String(m.technique),
            charge: m.charge === null || m.charge === undefined ? null : String(m.charge),
            comment: m.comment === null || m.comment === undefined ? null : String(m.comment),
            changebar: Boolean(m.changebar),
          },
          reference: reference
            ? {
              ...reference,
              inspire_lookup_by_id: toInspireLookupIdentifiers(reference),
            }
            : null,
          values,
          footnotes,
        };
      });

      const artifactName =
        params.artifact_name ??
        defaultArtifactName('pdg_get_measurements', `${pdgidRow.pdgid}__${params.start}__${params.limit}`, 'jsonl');
      const artifact = writeJsonlArtifact(artifactName, lines);

      const uniqueRef = new Set(lines.map(l => l.reference?.id).filter((id): id is number => typeof id === 'number'));

      return {
        uri: artifact.uri,
        summary: {
          pdgid: pdgidRow.pdgid,
          pdgid_id: pdgidRow.id,
          description: pdgidRow.description,
          data_type: pdgidRow.data_type,
          flags: pdgidRow.flags,
          start: params.start,
          limit: params.limit,
          has_more,
          next_page_hint: has_more
            ? `To get more measurements, call again with start: ${params.start + params.limit}, limit: ${params.limit}`
            : null,
          measurements: lines.length,
          references: uniqueRef.size,
          preview: lines.slice(0, 2).map(l => ({
            pdgmeasurement_id: l.measurement.id,
            reference: l.reference ? { id: l.reference.id, doi: l.reference.doi, inspire_id: l.reference.inspire_id } : null,
            values: l.values.slice(0, 2).map(v => ({ column_name: v.column_name, display_text: v.display_text })),
          })),
        },
        artifact: {
          name: artifact.name,
          mimeType: artifact.mimeType,
          size_bytes: artifact.size_bytes,
          sha256: artifact.sha256,
          rows: artifact.rows,
        },
      };
    },
  },
  {
    name: PDG_BATCH,
    description:
      'Execute multiple PDG tool calls in one request (writes a JSON artifact; supports limited parallelism; local-only; requires `PDG_DB_PATH` for most calls).',
    exposure: 'full',
    zodSchema: PdgBatchToolSchema,
    handler: async (params) => {
      const started_at = new Date().toISOString();
      let aborted = false;

      const results = await mapWithConcurrency(params.calls, params.concurrency, async (call: z.output<typeof PdgBatchCallSchema>, index) => {
        if (aborted) {
          return {
            index,
            tool: call.tool,
            ok: false as const,
            skipped: true as const,
            duration_ms: 0,
            error: null,
            result: null,
          };
        }

        const started_ms = Date.now();
        const spec = getToolSpec(call.tool);
        if (!spec) {
          const entry = {
            index,
            tool: call.tool,
            ok: false as const,
            skipped: false as const,
            duration_ms: Date.now() - started_ms,
            error: { code: 'INVALID_PARAMS', message: `Unknown tool: ${call.tool}` },
            result: null,
          };
          if (!params.continue_on_error) aborted = true;
          return entry;
        }

        if (!isToolExposed(spec, 'standard')) {
          const entry = {
            index,
            tool: call.tool,
            ok: false as const,
            skipped: false as const,
            duration_ms: Date.now() - started_ms,
            error: { code: 'INVALID_PARAMS', message: `Tool not exposed in standard mode: ${call.tool}` },
            result: null,
          };
          if (!params.continue_on_error) aborted = true;
          return entry;
        }

        let parsedArgs: unknown;
        try {
          parsedArgs = spec.zodSchema.parse(call.arguments ?? {});
        } catch (err) {
          if (err instanceof ZodError) {
            const entry = {
              index,
              tool: call.tool,
              ok: false as const,
              skipped: false as const,
              duration_ms: Date.now() - started_ms,
              error: {
                code: 'INVALID_PARAMS',
                message: `Invalid parameters for ${call.tool}`,
                data: { issues: err.issues },
              },
              result: null,
            };
            if (!params.continue_on_error) aborted = true;
            return entry;
          }
          throw err;
        }

        try {
          const result = await spec.handler(parsedArgs as any, {});
          return {
            index,
            tool: call.tool,
            ok: true as const,
            skipped: false as const,
            duration_ms: Date.now() - started_ms,
            error: null,
            result,
          };
        } catch (err) {
          const error = (() => {
            if (err instanceof McpError) {
              return { code: err.code, message: err.message, data: err.data };
            }
            const message = err instanceof Error ? err.message : String(err);
            return { code: 'INTERNAL_ERROR', message };
          })();

          const entry = {
            index,
            tool: call.tool,
            ok: false as const,
            skipped: false as const,
            duration_ms: Date.now() - started_ms,
            error,
            result: null,
          };
          if (!params.continue_on_error) aborted = true;
          return entry;
        }
      });

      const finished_at = new Date().toISOString();

      const ok = results.filter(r => r.ok).length;
      const skipped = results.filter(r => r.skipped).length;
      const errors = results.length - ok - skipped;

      const detail = {
        started_at,
        finished_at,
        concurrency: params.concurrency,
        continue_on_error: params.continue_on_error,
        calls: results,
      };

      const artifactName = params.artifact_name ?? defaultArtifactName('pdg_batch', `${started_at}__${results.length}`, 'json');
      const artifact = writeJsonArtifact(artifactName, detail);

      return {
        uri: artifact.uri,
        summary: {
          calls: results.length,
          ok,
          errors,
          skipped,
          preview: results.slice(0, 5).map(r => ({ tool: r.tool, ok: r.ok, skipped: r.skipped })),
        },
        artifact: {
          name: artifact.name,
          mimeType: artifact.mimeType,
          size_bytes: artifact.size_bytes,
          sha256: artifact.sha256,
        },
      };
    },
  },
];

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS.find(s => s.name === name);
}

export function getToolSpecs(mode: ToolExposureMode = 'standard'): ToolSpec[] {
  return TOOL_SPECS.filter(s => isToolExposed(s, mode));
}

export function getTools(mode: ToolExposureMode = 'standard'): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return getToolSpecs(mode).map(s => ({
    name: s.name,
    description: s.description,
    inputSchema: zodToMcpInputSchema(s.zodSchema),
  }));
}
