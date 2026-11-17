import { createHash } from 'crypto';
import { z } from 'zod';
import { optionalBudgetInt, FindConnectionsParamsSchema } from '@nullius/shared';
import { InspireRecidSchema, NumericRecidSchema } from '../inspireRecid.js';
import {
  NetworkAnalysisToolSchema,
  TopicAnalysisToolSchema,
  TraceOriginalSourceToolSchema,
} from '../research/schemas.js';
import { OutputDirSchema, SafePathSegmentSchema, SearchExportFormatSchema, strictBudgetInt } from './projectSchemas.js';

const SortSchema = z.enum(['mostrecent', 'mostcited']);
const JsonMarkdownSchema = z.enum(['json', 'markdown']);

export const InspireSearchToolSchema = z.object({
  query: z.string().min(1),
  sort: SortSchema.optional(),
  size: strictBudgetInt({ min: 1, max: 1000 }).default(25).describe(
    'Results per page. Default 25 when listing; in a file export (output_dir), if omitted: HEP_BUDGET_INSPIRE_SEARCH_PAGE_SIZE when set, otherwise 1000.'
  ),
  page: strictBudgetInt({ min: 1 }).default(1),
  format: JsonMarkdownSchema.optional().default('json'),
  review_mode: z.enum(['mixed', 'separate', 'deprioritize', 'exclude']).optional().default('mixed'),
  output_dir: OutputDirSchema.optional(),
  output_format: SearchExportFormatSchema.optional().default('jsonl'),
  artifact_name: SafePathSegmentSchema.optional(),
  meta_artifact_name: SafePathSegmentSchema.optional(),
  max_results: strictBudgetInt({ min: 1 }).default(100).describe(
    'When listing: if given (and page is not), pages are combined up to max_results results; if omitted, one page of size results is returned. In a file export (output_dir): at most 10000; if omitted, HEP_BUDGET_INSPIRE_SEARCH_MAX_RESULTS when set, otherwise 10000.'
  ),
}).strict();

export const InspireSearchNextToolSchema = z.object({
  next_url: z.string().min(1),
  review_mode: z.enum(['mixed', 'separate', 'deprioritize', 'exclude']).optional().default('mixed'),
});

export const FindConnectionsToolSchema = FindConnectionsParamsSchema.extend({
  recids: z.array(InspireRecidSchema).min(1),
}).strict();

const InspireLiteratureModeSchema = z.enum([
  'get_paper',
  'get_references',
  'lookup_by_id',
  'get_citations',
  'search_affiliation',
  'get_bibtex',
  'get_author',
]);

// BibTeX and citekey lookups also accept a single ID or a delimited list.
const InspireLiteratureRecidsSchema = z.union([
  z.array(InspireRecidSchema).min(1),
  NumericRecidSchema.transform(id => [String(id)]),
  z.string().regex(/^[,\s]*0*[1-9]\d*(?:[,\s]+0*[1-9]\d*)*[,\s]*$/)
    .transform(ids => ids.split(/[,\s]+/).filter(Boolean)),
]);

export const InspireLiteratureToolSchema = z
  .object({
    mode: InspireLiteratureModeSchema.describe(
      "Operation to run. Mode contracts: get_paper={recid} (size tolerated only for compatibility), lookup_by_id={identifier only; accidental size ignored}, get_references={recid,size?}, get_citations={recid,size?,sort?}, search_affiliation={affiliation,size?,sort?}, get_bibtex={recids}, get_author={identifier only; accidental size ignored}."
    ),
    recid: InspireRecidSchema.optional().describe(
      "INSPIRE literature record id as a digit string or a positive safe integer. Required for get_paper, get_references, and get_citations."
    ),
    size: optionalBudgetInt({ min: 1, max: 1000 }).optional().describe(
      "Page size / result limit. Only used by get_references, get_citations, and search_affiliation. Ignored by lookup_by_id, get_paper, and get_author for agent-call compatibility."
    ),
    identifier: z.union([z.string().trim().min(1), NumericRecidSchema]).optional().describe(
      "Lookup identifier for lookup_by_id or get_author. For lookup_by_id and get_author, pass identifier; accidental size is tolerated and ignored, but sort/page/options are not part of these modes. For lookup_by_id, identifier can be a recid (digit string or positive safe integer), DOI, or arXiv id. For get_author, use text containing an INSPIRE BAI, ORCID, or name query."
    ),
    sort: SortSchema.optional().describe(
      "Optional INSPIRE sort order. Only for get_citations and search_affiliation."
    ),
    affiliation: z.string().min(1).optional().describe(
      "Affiliation query string. Required only for search_affiliation."
    ),
    recids: InspireLiteratureRecidsSchema.optional().describe(
      "One or more INSPIRE recids. Required only for get_bibtex."
    ),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    const allowed = (() => {
      switch (v.mode) {
        case 'get_paper':
          return new Set(['recid', 'size']);
        case 'get_references':
          return new Set(['recid', 'size']);
        case 'lookup_by_id':
          return new Set(['identifier', 'size']);
        case 'get_citations':
          return new Set(['recid', 'size', 'sort']);
        case 'search_affiliation':
          return new Set(['affiliation', 'size', 'sort']);
        case 'get_bibtex':
          return new Set(['recids']);
        case 'get_author':
          return new Set(['identifier', 'size']);
        default:
          return new Set<string>();
      }
    })();

    const extraKeys = Object.keys(v)
      // The registry adds project_root to this tool as the common routing
      // field; it is independent of the mode-specific provider arguments.
      .filter(k => k !== 'mode' && k !== 'project_root')
      .filter(k => !allowed.has(k))
      .sort((a, b) => a.localeCompare(b));

    if (extraKeys.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.unrecognized_keys,
        keys: extraKeys,
        path: [],
      });
    }

    const requireKey = (key: 'recid' | 'identifier' | 'affiliation' | 'recids', message: string) => {
      if (!(key in v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [key] });
      }
    };

    switch (v.mode) {
      case 'get_paper':
      case 'get_references':
      case 'get_citations':
        requireKey('recid', `mode='${v.mode}' requires recid`);
        break;
      case 'search_affiliation':
        requireKey('affiliation', "mode='search_affiliation' requires affiliation");
        break;
      case 'get_author':
        if (typeof v.identifier === 'number') {
          ctx.addIssue({ code: 'custom', message: 'get_author requires a text identifier', path: ['identifier'] });
        }
        requireKey('identifier', "mode='get_author' requires identifier");
        break;
      case 'lookup_by_id':
        if (typeof v.identifier === 'string' && /^0+$/.test(v.identifier)) {
          ctx.addIssue({ code: 'custom', message: 'An INSPIRE recid must be positive', path: ['identifier'] });
        }
        requireKey('identifier', "mode='lookup_by_id' requires identifier");
        break;
      case 'get_bibtex':
        requireKey('recids', "mode='get_bibtex' requires recids");
        break;
      default:
        break;
    }
  });

export const InspireResolveCitekeyToolSchema = z
  .object({
    recid: InspireRecidSchema.optional(),
    recids: InspireLiteratureRecidsSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasRecid = typeof v.recid === 'string' && v.recid.trim().length > 0;
    const hasRecids = Array.isArray(v.recids) && v.recids.length > 0;
    if (!hasRecid && !hasRecids) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide 'recid' or 'recids'",
        path: ['recid'],
      });
    }
  });

export const PaperSourceToolSchema = z.object({
  identifier: z.string().min(1),
  mode: z.enum(['urls', 'content', 'metadata', 'auto']),
  options: z
    .object({
      prefer: z.enum(['latex', 'pdf', 'auto']).optional(),
      extract: z.boolean().optional(),
      auto_cleanup: z.boolean().optional(),
      check_availability: z.boolean().optional(),
      output_dir: z.string().optional(),
    })
    .optional(),
});

export const InspireParseLatexToolSchema = z.object({
  output_dir: OutputDirSchema,
  identifier: z.string().min(1),
  components: z
    .array(
      z.enum([
        'sections',
        'equations',
        'theorems',
        'citations',
        'figures',
        'tables',
        'bibliography',
        'all',
      ])
    )
    .min(1),
  // Exactly the options the parser reads; anything else is refused.
  options: z
    .object({
      include_key_equations: z.boolean().optional(),
      include_inline_math: z.boolean().optional(),
      include_section_content: z.boolean().optional(),
      max_section_content: strictBudgetInt({ min: 1 }),
      include_proofs: z.boolean().optional(),
      citation_context_window: strictBudgetInt({ min: 0 }),
      parse_table_data: z.boolean().optional(),
    })
    .strict()
    .optional(),
}).strict();

export const CleanupDownloadsToolSchema = z.object({
  arxiv_id: z.string().optional(),
  older_than_hours: optionalBudgetInt({ min: 0 }),
  dry_run: z.boolean().optional(),
  _confirm: z.boolean().optional(),
});

export const ValidateBibliographyToolSchema = z.object({
  identifier: z.string().min(1),
  scope: z.enum(['manual_only', 'all']).optional().default('manual_only'),
  check_discrepancies: z.boolean().optional().default(true),
  validate_against_inspire: z.boolean().optional().default(false),
  require_locatable: z.boolean().optional().default(true),
  max_entries: optionalBudgetInt({ min: 0 }),
});

let classifyPapersCache: ((papers: any[]) => any[]) | null = null;

export async function getClassifyPapers() {
  if (classifyPapersCache) return classifyPapersCache;
  const module = await import('../research/paperClassifier.js');
  classifyPapersCache = module.classifyPapers as unknown as (papers: unknown[]) => unknown[];
  return classifyPapersCache;
}

export function preprocessQuery(query: string): string {
  return query.replace(/\ba:["']([^"']+)["']/gi, 'a:$1');
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(String(value));
  if (t === 'undefined') return 'undefined';
  if (t === 'function' || t === 'symbol') return JSON.stringify(String(value));

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }

  return JSON.stringify(String(value));
}

export function hashParseLatexRequest(params: {
  identifier: string;
  components: string[];
  options?: unknown;
}): string {
  const material = stableStringify({
    identifier: params.identifier,
    components: params.components,
    options: params.options ?? null,
  });
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

export function isNoLatexSourceError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('latex source not available') || msg.includes('could not identify main .tex file');
}

export {
  JsonMarkdownSchema,
  NetworkAnalysisToolSchema,
  SortSchema,
  TopicAnalysisToolSchema,
  TraceOriginalSourceToolSchema,
};
