import { z } from 'zod';
import { zodToMcpInputSchema } from './mcpSchema.js';
import { normalizeZoteroArxivId, normalizeZoteroDoi } from '../zotero/identifiers.js';
import { consumeConfirmAction } from '../zotero/confirm.js';
import {
  zoteroAdd,
  zoteroAddConfirm,
  zoteroDownloadAttachment,
  zoteroExportItems,
  zoteroFindItems,
  zoteroGetAttachmentFulltext,
  zoteroGetItem,
  zoteroGetItemAttachments,
  zoteroGetSelectedCollection,
  zoteroListCollectionPaths,
  zoteroListCollections,
  zoteroListItems,
  zoteroListTags,
  zoteroSearchItems,
} from '../zotero/tools.js';

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

const PaginationSchema = z.object({
  limit: z.number().int().positive().max(200).optional().default(50),
  start: z.number().int().nonnegative().optional().default(0),
});

const ZoteroFindItemsIdentifiersSchema = z
  .object({
    doi: z.string().trim().min(1).max(256).optional(),
    arxiv_id: z.string().trim().min(1).max(64).optional(),
    inspire_recid: z.string().trim().min(1).max(32).optional(),
    title: z.string().trim().min(1).max(512).optional(),
    item_key: SafePathSegmentSchema.optional(),
  })
  .describe('Optional identifier constraints (exact matching when match=exact).');

const ZoteroFindItemsFiltersSchema = z
  .object({
    tags: z
      .array(z.string().trim().min(1).max(128))
      .max(20)
      .optional()
      .default([])
      .transform(v => Array.from(new Set(v)))
      .describe('Match items containing these tags (case-insensitive)'),
    authors: z
      .array(z.string().trim().min(1).max(256))
      .max(20)
      .optional()
      .default([])
      .transform(v => Array.from(new Set(v)))
      .describe('Match item creators/authors by name (case-insensitive)'),
    publication_title: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe('Match Zotero publicationTitle (journal / proceedings title)'),
    year: z.number().int().min(1500).max(2100).optional().describe('Match year extracted from Zotero date'),
    volume: z.string().trim().min(1).max(32).optional().describe('Match Zotero volume'),
    issue: z.string().trim().min(1).max(32).optional().describe('Match Zotero issue'),
  })
  .describe('Optional non-identifier filters for zotero_find_items.');

const ZoteroFindItemsToolSchema = z
  .object({
    identifiers: ZoteroFindItemsIdentifiersSchema.optional().default(() => ({})),
    filters: ZoteroFindItemsFiltersSchema.optional().default(() => ({ tags: [], authors: [] })),
    collection_key: SafePathSegmentSchema.optional().describe('Optional collection scope (narrow candidate search to one collection)'),
    include_children: z
      .boolean()
      .optional()
      .default(false)
      .describe('When collection_key is set, also search within descendant sub-collections'),
    limit: z.number().int().positive().max(50).optional().default(20),
    include_attachments: z.boolean().optional().default(false),
    match: z.enum(['exact', 'fuzzy']).optional().default('exact'),
  })
  .superRefine((v, ctx) => {
    const hasIdentifier =
      Boolean(v.identifiers.doi)
      || Boolean(v.identifiers.arxiv_id)
      || Boolean(v.identifiers.inspire_recid)
      || Boolean(v.identifiers.title)
      || Boolean(v.identifiers.item_key);
    const hasFilter =
      (Array.isArray((v.filters as any).tags) && (v.filters as any).tags.length > 0)
      || (Array.isArray((v.filters as any).authors) && (v.filters as any).authors.length > 0)
      || Boolean((v.filters as any).publication_title)
      || Boolean((v.filters as any).year)
      || Boolean((v.filters as any).volume)
      || Boolean((v.filters as any).issue);
    if (!hasIdentifier && !hasFilter) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one identifier or filter is required' });
      return;
    }
    if (v.include_children && !v.collection_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'include_children requires collection_key',
        path: ['include_children'],
      });
      return;
    }
    if (v.match !== 'exact') return;
    if (v.identifiers.doi) {
      const normalized = normalizeZoteroDoi(v.identifiers.doi);
      if (!normalized) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unrecognized DOI format', path: ['identifiers', 'doi'] });
      }
    }
    if (v.identifiers.arxiv_id) {
      const normalized = normalizeZoteroArxivId(v.identifiers.arxiv_id);
      if (!normalized) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Unrecognized arXiv ID format',
          path: ['identifiers', 'arxiv_id'],
        });
      }
    }
    if (v.identifiers.inspire_recid && !/^\d+$/.test(v.identifiers.inspire_recid)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'inspire_recid must be numeric',
        path: ['identifiers', 'inspire_recid'],
      });
    }
  })
  .transform(v => {
    if (v.match !== 'exact') return v;
    return {
      ...v,
      identifiers: {
        ...v.identifiers,
        doi: v.identifiers.doi ? normalizeZoteroDoi(v.identifiers.doi) : undefined,
        arxiv_id: v.identifiers.arxiv_id ? normalizeZoteroArxivId(v.identifiers.arxiv_id) : undefined,
      },
    };
  });

const ZoteroSearchItemsToolSchema = z
  .object({
    q: z.string().trim().min(1).max(512).optional().describe('Free-text search query (Zotero Local API `q`)'),
    qmode: z
      .enum(['titleCreatorYear', 'everything'])
      .optional()
      .describe('Search mode for `q` (Zotero Local API `qmode`)'),
    tag: z.string().trim().min(1).max(256).optional().describe('Tag filter (Zotero Local API `tag`)'),
    item_type: z.string().trim().min(1).max(64).optional().describe('Item type filter (Zotero Local API `itemType`)'),
    collection_key: SafePathSegmentSchema.optional().describe('Optional collection scope'),
    top_level_only: z
      .boolean()
      .optional()
      .default(true)
      .describe('When true, only return top-level items (excludes attachments/notes)'),
    include_trashed: z.boolean().optional().default(false).describe('Include trashed items (Zotero Local API `includeTrashed`)'),
    sort: z
      .enum(['dateAdded', 'dateModified', 'title', 'creator', 'itemType', 'date'])
      .optional()
      .describe('Sort key (Zotero Local API `sort`)'),
    direction: z.enum(['asc', 'desc']).optional().describe('Sort direction (Zotero Local API `direction`)'),
    limit: z.number().int().positive().max(50).optional().default(20),
    start: z.number().int().nonnegative().optional().default(0),
  })
  .superRefine((v, ctx) => {
    if (v.q || v.tag || v.collection_key || v.item_type) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'At least one of q, tag, collection_key, or item_type is required',
    });
  })
  .describe('Search Zotero items via Local API (q/qmode/tag/itemType, with optional collection scope).');

const ZoteroGetSelectedCollectionToolSchema = z.object({
  allow_library_root: z
    .boolean()
    .optional()
    .default(false)
    .describe('Allow returning library-root selection (otherwise errors when Zotero UI selects root)'),
}).describe('Resolve Zotero UI-selected collection to a Local API collection_key (via connector).');

const ZoteroTagSchema = z.string().trim().min(1).max(128);
const ZoteroTagsSchema = z
  .array(ZoteroTagSchema)
  .optional()
  .default([])
  .transform(tags => Array.from(new Set(tags)));

const ZoteroAddSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item'), item: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('inspire'), recid: z.string().trim().min(1) }),
  z.object({ type: z.literal('doi'), doi: z.string().trim().min(1) }),
  z.object({ type: z.literal('arxiv'), arxiv_id: z.string().trim().min(1) }),
]);

const ZoteroAddToolSchema = z
  .object({
    source: ZoteroAddSourceSchema,
    collection_keys: z
      .array(SafePathSegmentSchema)
      .optional()
      .default([])
      .transform(keys => Array.from(new Set(keys)))
      .describe(
        'Optional Zotero collection keys to add the item into. If omitted/empty, zotero_add writes into the currently selected Zotero collection (connector mapping).'
      ),
    allow_library_root: z
      .boolean()
      .optional()
      .default(false)
      .describe('Allow writing to library root when collection_keys are empty and Zotero selects root'),
    tags: ZoteroTagsSchema,
    note: z.string().optional().describe('Optional note to attach (plain text)'),
    file_path: z.string().optional().refine(
      v => v === undefined || v === '' || (typeof v === 'string' && v.startsWith('/')),
      { message: 'file_path must be an absolute path (starting with /)' }
    ).describe('Optional absolute file path to attach as a linked file (e.g. a downloaded PDF). Requires Zotero Local API write access.'),
    dedupe: z.enum(['return_existing', 'update_existing', 'error_on_existing']).optional().default('return_existing'),
    open_in_zotero: z.boolean().optional().default(true),
  })
  .describe(
    "Add/update a Zotero item. Required: source={type:...}. Example: { source:{type:'doi',doi:'10.1000/xyz'}, tags:['hep'], note:'...', collection_keys:['ABCD1234'] }"
  );

const ZoteroListTagsScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library') }),
  z.object({ kind: z.literal('collection'), collection_key: SafePathSegmentSchema }),
  z.object({ kind: z.literal('item'), item_key: SafePathSegmentSchema }),
]);

const ZoteroListTagsToolSchema = PaginationSchema.extend({
  scope: ZoteroListTagsScopeSchema.optional().default({ kind: 'library' }),
  q: z.string().trim().min(1).max(256).optional(),
  qmode: z.enum(['contains', 'startsWith']).optional(),
});

const ZoteroExportFormatSchema = z.enum([
  'bibtex',
  'biblatex',
  'csljson',
  'ris',
  'refer',
  'mods',
  'csv',
  'tei',
  'wikipedia',
  'rdf_dc',
  'rdf_zotero',
  'bib',
]);

const ZoteroExportItemsScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('item_keys'),
    item_keys: z.array(SafePathSegmentSchema).min(1).max(50),
  }),
  PaginationSchema.extend({
    kind: z.literal('collection'),
    collection_key: SafePathSegmentSchema,
  }),
  PaginationSchema.extend({
    kind: z.literal('library_top'),
  }),
]);

const ZoteroExportItemsToolSchema = z.object({
  scope: ZoteroExportItemsScopeSchema,
  format: ZoteroExportFormatSchema,
  style: z.string().trim().min(1).max(1024).optional(),
  locale: z.string().trim().min(1).max(64).optional(),
  linkwrap: z.boolean().optional(),
  max_chars: z.number().int().min(1_000).max(2_000_000).optional().default(200_000),
});

const ZoteroListCollectionPathsToolSchema = z.object({
  query: z.string().trim().min(1).max(256).optional(),
  match: z.enum(['contains', 'starts_with']).optional().default('contains'),
  case_sensitive: z.boolean().optional().default(false),
  limit: z.number().int().positive().max(500).optional().default(200),
  start: z.number().int().nonnegative().optional().default(0),
});

// NOTE: Keep zotero_local gateway-compatible: avoid top-level oneOf/anyOf/allOf in JSON Schema.
// Some API gateways reject those at the top level when loading MCP tool schemas.
const ZoteroLocalToolSchema = z
  .object({
    mode: z.enum([
      'list_collections',
      'list_collection_paths',
      'list_items',
      'get_item',
      'get_item_attachments',
      'download_attachment',
      'get_attachment_fulltext',
      'list_tags',
    ]),

    // Pagination (used by list_* modes; ignored otherwise)
    limit: PaginationSchema.shape.limit,
    start: PaginationSchema.shape.start,

    // list_items
    collection_key: SafePathSegmentSchema.optional(),

    // get_item / get_item_attachments
    item_key: SafePathSegmentSchema.optional(),

    // download_attachment / get_attachment_fulltext
    attachment_key: SafePathSegmentSchema.optional(),

    // list_collection_paths
    query: ZoteroListCollectionPathsToolSchema.shape.query,
    match: ZoteroListCollectionPathsToolSchema.shape.match,
    case_sensitive: ZoteroListCollectionPathsToolSchema.shape.case_sensitive,

    // list_tags
    scope: ZoteroListTagsToolSchema.shape.scope,
    q: ZoteroListTagsToolSchema.shape.q,
    qmode: ZoteroListTagsToolSchema.shape.qmode,
  })
  .superRefine((v, ctx) => {
    if ((v.mode === 'get_item' || v.mode === 'get_item_attachments') && !v.item_key) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'item_key is required for this mode', path: ['item_key'] });
    }
    if ((v.mode === 'download_attachment' || v.mode === 'get_attachment_fulltext') && !v.attachment_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'attachment_key is required for this mode',
        path: ['attachment_key'],
      });
    }
  });

const ZoteroConfirmToolSchema = z
  .object({
    confirm_token: z.string().trim().min(1).max(200),
  })
  .describe('Confirm and execute a previewed Zotero write operation using a confirm_token.');

type ZoteroQueryItemsBridgeRequest =
  | { mode: 'find'; params: z.output<typeof ZoteroFindItemsToolSchema> }
  | { mode: 'search'; params: z.output<typeof ZoteroSearchItemsToolSchema> };

// Phase 4.5 bridge seam: keep find/search semantics explicit while sharing a single dispatch path.
async function runZoteroQueryItemsBridge(request: ZoteroQueryItemsBridgeRequest): Promise<unknown> {
  if (request.mode === 'find') {
    return zoteroFindItems(request.params);
  }
  return zoteroSearchItems(request.params);
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'zotero_local',
    exposure: 'standard',
    description:
      'Unified Zotero Local API tool (requires Zotero Local API at `http://127.0.0.1:23119`). Modes: list_collections/list_collection_paths/list_items/get_item/get_item_attachments/download_attachment/get_attachment_fulltext/list_tags (fulltext requires `ZOTERO_DATA_DIR`; local-only).',
    zodSchema: ZoteroLocalToolSchema,
    handler: async params => {
      switch (params.mode) {
        case 'list_collections':
          return zoteroListCollections({ limit: params.limit, start: params.start });
        case 'list_collection_paths':
          return zoteroListCollectionPaths({
            query: params.query,
            match: params.match,
            case_sensitive: params.case_sensitive,
            limit: params.limit,
            start: params.start,
          });
        case 'list_items':
          return zoteroListItems({ collection_key: params.collection_key, limit: params.limit, start: params.start });
        case 'get_item': {
          if (!params.item_key) throw new Error('item_key is required for mode=get_item');
          return zoteroGetItem({ item_key: params.item_key });
        }
        case 'get_item_attachments': {
          if (!params.item_key) throw new Error('item_key is required for mode=get_item_attachments');
          return zoteroGetItemAttachments({ item_key: params.item_key });
        }
        case 'download_attachment': {
          if (!params.attachment_key) throw new Error('attachment_key is required for mode=download_attachment');
          return zoteroDownloadAttachment({ attachment_key: params.attachment_key });
        }
        case 'get_attachment_fulltext': {
          if (!params.attachment_key) throw new Error('attachment_key is required for mode=get_attachment_fulltext');
          return zoteroGetAttachmentFulltext({ attachment_key: params.attachment_key });
        }
        case 'list_tags':
          return zoteroListTags({
            scope: params.scope,
            q: params.q,
            qmode: params.qmode,
            limit: params.limit,
            start: params.start,
          });
        default:
          throw new Error(`Unknown zotero_local mode: ${String((params as { mode?: unknown }).mode)}`);
      }
    },
  },
  {
    name: 'zotero_find_items',
    exposure: 'standard',
    description:
      'Resolve Zotero items by identifiers (doi/arxiv/recid/item_key/title) with optional local filters (tags/authors/publication_title/year/volume/issue), optionally scoped by collection_key (and include_children). Internally, it fetches a limited candidate set via Zotero Local API search and then verifies matches; for interactive browsing, prefer zotero_search_items (local-only).',
    zodSchema: ZoteroFindItemsToolSchema,
    handler: async params => runZoteroQueryItemsBridge({ mode: 'find', params }),
  },
  {
    name: 'zotero_search_items',
    exposure: 'standard',
    description:
      'Browse/search Zotero items via Zotero Local API query params (q/qmode/tag/itemType, optional collection scope). Returns summarized items with select_uri + identifier digest; does not guarantee exact identifier resolution (use zotero_find_items for that; local-only).',
    zodSchema: ZoteroSearchItemsToolSchema,
    handler: async params => runZoteroQueryItemsBridge({ mode: 'search', params }),
  },
  {
    name: 'zotero_export_items',
    exposure: 'standard',
    description: 'Export Zotero items into BibTeX/CSL-JSON/RIS/etc via Local API (local-only).',
    zodSchema: ZoteroExportItemsToolSchema,
    handler: async params => zoteroExportItems(params),
  },
  {
    name: 'zotero_get_selected_collection',
    exposure: 'standard',
    description:
      'Resolve the Zotero UI-selected collection to a Local API collection_key (requires Zotero Connector + Zotero open; maps connector path → Local API key; local-only).',
    zodSchema: ZoteroGetSelectedCollectionToolSchema,
    handler: async params => zoteroGetSelectedCollection(params),
  },
  {
    name: 'zotero_add',
    exposure: 'standard',
    description:
      'Preview a Zotero add/update operation and return a confirm_token; execute via zotero_confirm (local-only write). ' +
      'Sources: `item` (no network), or `inspire`/`doi`/`arxiv` (fetches metadata from INSPIRE, with CrossRef fallback for non-HEP DOIs; network). ' +
      'If collection_keys is empty/missing, writes into the currently selected Zotero collection (requires Zotero Connector mapping); library root is rejected unless allow_library_root=true.',
    zodSchema: ZoteroAddToolSchema,
    handler: async params => zoteroAdd(params),
  },
  {
    name: 'zotero_confirm',
    exposure: 'standard',
    description:
      'Confirm and execute a previewed Zotero write operation (local-only). Use the confirm_token returned by tools like zotero_add.',
    zodSchema: ZoteroConfirmToolSchema,
    handler: async params => {
      const stored = consumeConfirmAction(params.confirm_token);
      switch (stored.action.kind) {
        case 'zotero_add_v1': {
          const result = await zoteroAddConfirm(stored.action.payload.params);
          return {
            status: 'executed',
            tool: 'zotero_add',
            executed_at: new Date().toISOString(),
            confirm_token_consumed: stored.token,
            result,
          };
        }
        default:
          throw new Error(`Unknown confirm action kind: ${String((stored.action as any)?.kind)}`);
      }
    },
  },
];

const TOOL_SPECS_BY_NAME = new Map<string, ToolSpec>(TOOL_SPECS.map(spec => [spec.name, spec]));

export function getToolSpec(name: string): ToolSpec | undefined {
  return TOOL_SPECS_BY_NAME.get(name);
}

export function getToolSpecs(mode: ToolExposureMode): ToolSpec[] {
  return TOOL_SPECS.filter(spec => isToolExposed(spec, mode));
}

export function getTools(mode: ToolExposureMode = 'standard') {
  return getToolSpecs(mode).map(spec => {
    return {
      name: spec.name,
      description: spec.description,
      inputSchema: zodToMcpInputSchema(spec.zodSchema),
    };
  });
}
