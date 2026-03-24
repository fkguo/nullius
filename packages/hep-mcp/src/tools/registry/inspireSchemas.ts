import { createHash } from 'crypto';
import { z } from 'zod';
import { optionalBudgetInt, FindConnectionsParamsSchema } from '@autoresearch/shared';
import {
  TimeRangeSchema,
  NetworkAnalysisToolSchema,
  TopicAnalysisToolSchema,
  TraceOriginalSourceToolSchema,
} from '../research/schemas.js';
import { SafePathSegmentSchema, SearchExportFormatSchema } from './projectSchemas.js';

const SortSchema = z.enum(['mostrecent', 'mostcited']);
const JsonMarkdownSchema = z.enum(['json', 'markdown']);

export const InspireSearchToolSchema = z.object({
  query: z.string().min(1),
  sort: SortSchema.optional(),
  size: optionalBudgetInt({ min: 1, max: 1000 }).default(25),
  page: optionalBudgetInt({ min: 1 }).default(1),
  format: JsonMarkdownSchema.optional().default('json'),
  review_mode: z.enum(['mixed', 'separate', 'deprioritize', 'exclude']).optional().default('mixed'),
  run_id: SafePathSegmentSchema.optional(),
  output_format: SearchExportFormatSchema.optional().default('jsonl'),
  artifact_name: SafePathSegmentSchema.optional(),
  meta_artifact_name: SafePathSegmentSchema.optional(),
  max_results: optionalBudgetInt({ min: 1 }).default(100),
});

export const InspireSearchNextToolSchema = z.object({
  next_url: z.string().min(1),
  review_mode: z.enum(['mixed', 'separate', 'deprioritize', 'exclude']).optional().default('mixed'),
});

export const FindConnectionsToolSchema = FindConnectionsParamsSchema.strict();

const InspireLiteratureModeSchema = z.enum([
  'get_paper',
  'get_references',
  'lookup_by_id',
  'get_citations',
  'search_affiliation',
  'get_bibtex',
  'get_author',
]);

const InspireLiteratureRecidsSchema = z.preprocess(
  value => {
    if (Array.isArray(value)) {
      return value
        .map(v => (typeof v === 'number' ? String(v) : v))
        .map(v => (typeof v === 'string' ? v.trim() : v))
        .filter(v => (typeof v === 'string' ? v.length > 0 : true));
    }

    if (typeof value === 'number') {
      return [String(value)];
    }

    if (typeof value === 'string') {
      return value
        .split(/[,\s]+/g)
        .map(v => v.trim())
        .filter(v => v.length > 0);
    }

    return value;
  },
  z.array(z.string().min(1)).min(1)
);

export const InspireLiteratureToolSchema = z
  .object({
    mode: InspireLiteratureModeSchema,
    recid: z.string().min(1).optional(),
    size: optionalBudgetInt({ min: 1 }),
    identifier: z.string().min(1).optional(),
    sort: SortSchema.optional(),
    affiliation: z.string().min(1).optional(),
    recids: InspireLiteratureRecidsSchema.optional(),
  })
  .passthrough()
  .superRefine((v, ctx) => {
    const allowed = (() => {
      switch (v.mode) {
        case 'get_paper':
          return new Set(['recid']);
        case 'get_references':
          return new Set(['recid', 'size']);
        case 'lookup_by_id':
          return new Set(['identifier']);
        case 'get_citations':
          return new Set(['recid', 'size', 'sort']);
        case 'search_affiliation':
          return new Set(['affiliation', 'size', 'sort']);
        case 'get_bibtex':
          return new Set(['recids']);
        case 'get_author':
          return new Set(['identifier']);
        default:
          return new Set<string>();
      }
    })();

    const extraKeys = Object.keys(v)
      .filter(k => k !== 'mode')
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
      case 'lookup_by_id':
      case 'get_author':
        requireKey('identifier', `mode='${v.mode}' requires identifier`);
        break;
      case 'get_bibtex':
        requireKey('recids', "mode='get_bibtex' requires recids");
        break;
      default:
        break;
    }
  });

const InspireRecidSchema = z.preprocess(
  value => {
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return value.trim();
    return value;
  },
  z.string().min(1)
);

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

export const CriticalResearchToolSchema = z
  .object({
    mode: z.enum(['evidence', 'conflicts', 'analysis', 'reviews', 'theoretical']),
    recids: z.array(z.string().min(1)).min(1),
    run_id: SafePathSegmentSchema.optional(),
    options: z
      .object({
        search_confirmations: z.boolean().optional(),
        max_search_results: optionalBudgetInt({ min: 1 }),
        target_quantities: z.array(z.string()).optional(),
        min_tension_sigma: z.number().optional(),
        include_tables: z.boolean().optional(),
        include_evidence: z.boolean().optional(),
        include_questions: z.boolean().optional(),
        include_assumptions: z.boolean().optional(),
        check_literature: z.boolean().optional(),
        assumption_max_depth: optionalBudgetInt({ min: 0 }),
        current_threshold_years: z.number().int().optional(),
        subject_entity: z.string().min(1).optional(),
        inputs: z.array(z.enum(['title', 'abstract', 'citation_context', 'evidence_paragraph'])).optional(),
        max_papers: optionalBudgetInt({ min: 1 }),
        max_claim_candidates_per_paper: optionalBudgetInt({ min: 1 }),
        max_candidates_total: optionalBudgetInt({ min: 1 }),
        llm_mode: z.enum(['passthrough', 'client', 'internal']).optional(),
        max_llm_requests: optionalBudgetInt({ min: 1 }),
        strict_llm: z.boolean().optional(),
        prompt_version: z.string().min(1).optional(),
        stable_sort: z.boolean().optional(),
        client_llm_responses: z
          .array(
            z
              .object({
                request_id: z.string().min(1),
                json_response: z.unknown(),
                model: z.string().optional(),
                created_at: z.string().optional(),
              })
              .passthrough()
          )
          .optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'theoretical' && !v.run_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "mode='theoretical' requires run_id (Evidence-first: writes run artifacts)",
        path: ['run_id'],
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
  run_id: SafePathSegmentSchema,
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
  options: z
    .object({
      format: JsonMarkdownSchema.optional(),
      include_external: z.boolean().optional(),
      max_depth: optionalBudgetInt({ min: 1 }),
      cross_validate: z.boolean().optional(),
    })
    .optional(),
});

export const FindCrossoverTopicsToolSchema = z.object({
  categories: z.array(z.string().min(1)).length(2).optional(),
  scan_popular: z.boolean().optional().default(true),
  time_range: TimeRangeSchema,
  min_papers: z.number().int().optional(),
  limit: optionalBudgetInt({ min: 1 }),
});

export const AnalyzeCitationStanceToolSchema = z.object({
  latex_content: z.string().min(1),
  target_recid: z.string().min(1),
  bib_content: z.string().optional(),
  max_contexts: optionalBudgetInt({ min: 1 }).default(20),
});

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
