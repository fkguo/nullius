import {
  invalidParams,
  INSPIRE_SEARCH,
  INSPIRE_SEARCH_NEXT,
  INSPIRE_LITERATURE,
  INSPIRE_RESOLVE_CITEKEY,
} from '@autoresearch/shared';
import * as api from '../../api/client.js';
import { extractKeyFromBibtex } from '../../utils/bibtex.js';
import { discoveryNextActions, withNextActions } from '../utils/discoveryHints.js';
import type { ToolSpec } from './types.js';
import {
  InspireSearchToolSchema,
  InspireSearchNextToolSchema,
  InspireLiteratureToolSchema,
  InspireResolveCitekeyToolSchema,
  getClassifyPapers,
  preprocessQuery,
} from './inspireSchemas.js';

export const RAW_INSPIRE_SEARCH_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  {
    name: INSPIRE_SEARCH,
    tier: 'core',
    exposure: 'standard',
    description: `Search INSPIRE-HEP literature database (network). Supports combining multiple conditions in one query.

Note: Some MCP clients prefix tool names (e.g. \`mcp__hep__inspire_search\`); always use the exact tool name shown by your client.

Author search: Use "a:lastname, firstname" or BAI format "a:Feng.Kun.Guo.1". Do NOT use quotes around author names.

Author disambiguation tip (IMPORTANT for common names):
- Prefer INSPIRE BAI when available: \`a:E.Witten.1\` (stable unique author identifier).
- If you only have a name, first call \`inspire_literature\` with \`mode=get_author\` to obtain \`bai\`, then search with \`a:<bai>\`.

Full-text search: Use "fulltext:" to search paper content (not just metadata).
- fulltext:"dark matter detection" - search for exact phrase in paper text
- fulltext:WIMP AND t:direct - combine full-text with title search

Common search operators:
- a: author (e.g., "a:guo, feng-kun" or "a:Feng.Kun.Guo.1")
- fa: first author (e.g., "fa:witten")
- t: title (e.g., "t:pentaquark")
- fulltext: full-text search (e.g., "fulltext:lattice QCD")
- topcite: citation count (e.g., "topcite:250+" for >=250 citations)
- authorcount: author count (e.g., "authorcount:1->10" for 1-10 authors)
- date: date range (e.g., "date:2020->2024")
- j: journal (e.g., "j:Phys.Rev.D")
- eprint: arXiv ID (e.g., "eprint:2301.12345")
- primarch: primary arXiv category (e.g., "primarch:hep-ph", "primarch:hep-th")
- cn: collaboration (e.g., "cn:LHCb")
- aff: affiliation (e.g., "aff:CERN")
- tc: document type (p=published, c=conference, r=review, t=thesis)

Review paper handling via \`review_mode\`:
- mixed (default): keep result order
- exclude: remove review papers
- deprioritize/separate: move review papers to the end

Example combined query: "a:Feng.Kun.Guo.1 topcite:250+ authorcount:1->10"`,
    zodSchema: InspireSearchToolSchema,
    handler: async params => {
      const query = preprocessQuery(params.query);
      const result = await api.search(query, {
        sort: params.sort,
        size: params.size,
        page: params.page,
      });

      const applyReviewMode = (r: typeof result) => {
        if (params.review_mode === 'mixed' || r.papers.length === 0) return r;
        return getClassifyPapers().then(classifyPapersFn => {
          const classified = classifyPapersFn(r.papers) as Array<{ is_review?: boolean }>;
          const nonReviews = classified.filter(p => !p.is_review);
          const reviews = classified.filter(p => p.is_review);
          if (params.review_mode === 'exclude') {
            return { ...r, papers: nonReviews as typeof r.papers, total: nonReviews.length };
          }
          return { ...r, papers: [...nonReviews, ...reviews] as typeof r.papers };
        });
      };

      const final = await applyReviewMode(result);
      return withNextActions(final, discoveryNextActions(final.papers));
    },
  },
  {
    name: INSPIRE_SEARCH_NEXT,
    tier: 'core',
    exposure: 'standard',
    description:
      'Follow an INSPIRE `next_url` returned by `inspire_search` with strict same-origin checks (network; avoids arbitrary URL fetch).',
    zodSchema: InspireSearchNextToolSchema,
    handler: async params => {
      const result = await api.searchByUrl(params.next_url, { max_page_size: 100 });

      if (params.review_mode === 'mixed' || result.papers.length === 0) {
        return result;
      }

      const classifyPapersFn = await getClassifyPapers();
      const classified = classifyPapersFn(result.papers) as Array<{ is_review?: boolean }>;
      const nonReviews = classified.filter(p => !p.is_review);
      const reviews = classified.filter(p => p.is_review);

      if (params.review_mode === 'exclude') {
        return { ...result, papers: nonReviews as typeof result.papers, total: nonReviews.length };
      }

      return { ...result, papers: [...nonReviews, ...reviews] as typeof result.papers };
    },
  },
  {
    name: INSPIRE_LITERATURE,
    tier: 'consolidated',
    exposure: 'standard',
    description: `Unified INSPIRE literature access tool (network).

Modes + required args:
- get_paper: { recid }
- get_references: { recid, size? }
- lookup_by_id: { identifier } // identifier can be a recid, DOI (10.x), or arXiv id; tool auto-routes
- get_citations: { recid, size?, sort? } // IMPORTANT: use recid (not identifier); use size (not options.limit)
- search_affiliation: { affiliation, size?, sort? }
- get_bibtex: { recids }
- get_author: { identifier } // identifier can be INSPIRE BAI (e.g. E.Witten.1), ORCID, or a name query; returns \`bai\` for disambiguation.

Tip: For ambiguous names, call \`get_author\` first, then use \`inspire_search\` with \`query=\"a:<bai>\"\`.`,
    zodSchema: InspireLiteratureToolSchema,
    handler: async params => {
      switch (params.mode) {
        case 'get_paper':
          return api.getPaper(params.recid!);
        case 'get_references':
          return api.getReferences(params.recid!, params.size);
        case 'lookup_by_id': {
          const identifier = params.identifier!;
          if (/^\d+$/.test(identifier)) return api.getPaper(identifier);
          if (identifier.startsWith('10.')) return api.getByDoi(identifier);
          return api.getByArxiv(identifier);
        }
        case 'get_citations':
          return api.getCitations(params.recid!, { sort: params.sort, size: params.size ?? 25 });
        case 'search_affiliation':
          return api.search(`aff:${params.affiliation!}`, { sort: params.sort, size: params.size ?? 25 });
        case 'get_bibtex':
          return api.getBibtex(params.recids!);
        case 'get_author':
          return api.getAuthor(params.identifier!);
        default:
          throw new Error(`Unknown inspire_literature mode: ${String((params as { mode?: unknown }).mode)}`);
      }
    },
  },
  {
    name: INSPIRE_RESOLVE_CITEKEY,
    tier: 'consolidated',
    exposure: 'standard',
    description:
      'Resolve INSPIRE BibTeX citekey + BibTeX + canonical links for recid(s) (network). Returns {results:[{recid,citekey,bibtex,links:{inspire,doi?,arxiv?}}]}.',
    zodSchema: InspireResolveCitekeyToolSchema,
    handler: async params => {
      const rawRecids = [
        ...(Array.isArray(params.recids) ? params.recids : []),
        ...(typeof params.recid === 'string' ? [params.recid] : []),
      ]
        .map(r => String(r).trim())
        .filter(r => r.length > 0);

      const uniqueRecids = Array.from(new Set(rawRecids));

      const [papers, bulkBibtex] = await Promise.all([api.batchGetPapers(uniqueRecids), api.getBibtex(uniqueRecids)]);
      const paperByRecid = new Map(papers.map(p => [p.recid, p]));

      const bibtexByCitekey = new Map<string, string>();
      {
        const cleaned = String(bulkBibtex ?? '')
          .replace(/^\uFEFF/, '')
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .trim();
        const re = /^\s*@/gm;
        const starts: number[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(cleaned)) !== null) {
          starts.push(m.index);
        }
        for (let i = 0; i < starts.length; i += 1) {
          const start = starts[i]!;
          const end = i + 1 < starts.length ? starts[i + 1]! : cleaned.length;
          const block = cleaned.slice(start, end).trim();
          if (!block) continue;
          const key = extractKeyFromBibtex(block);
          if (!key) continue;
          if (!bibtexByCitekey.has(key)) {
            bibtexByCitekey.set(key, block);
          }
        }
      }

      const results: Array<{
        recid: string;
        citekey: string;
        bibtex: string;
        links: { inspire: string; doi?: string; arxiv?: string };
      }> = [];

      for (const recid of uniqueRecids) {
        const links: { inspire: string; doi?: string; arxiv?: string } = {
          inspire: `https://inspirehep.net/literature/${recid}`,
        };

        const paper = paperByRecid.get(recid);
        if (paper?.doi_url) links.doi = paper.doi_url;
        if (paper?.arxiv_url) links.arxiv = paper.arxiv_url;

        const expectedTexkey = typeof paper?.texkey === 'string' ? paper.texkey.trim() : '';

        const bibtexFromBulk = expectedTexkey ? bibtexByCitekey.get(expectedTexkey) : undefined;
        if (bibtexFromBulk) {
          const extracted = extractKeyFromBibtex(bibtexFromBulk);
          if (!extracted) {
            throw invalidParams(`Could not extract BibTeX entry key for citekey=${expectedTexkey}`, {
              recid,
              citekey: expectedTexkey,
              bibtex_preview: bibtexFromBulk.slice(0, 240),
            });
          }
          if (extracted !== expectedTexkey) {
            throw invalidParams(`BibTeX entry key mismatch for recid=${recid}`, {
              recid,
              expected_citekey: expectedTexkey,
              extracted_citekey: extracted,
              bibtex_preview: bibtexFromBulk.slice(0, 240),
            });
          }
          results.push({ recid, citekey: expectedTexkey, bibtex: bibtexFromBulk, links });
          continue;
        }

        const bibtex = String(await api.getBibtex([recid])).trim();
        const citekey = extractKeyFromBibtex(bibtex);
        if (!citekey) {
          throw invalidParams(`Could not extract BibTeX entry key for recid=${recid}`, {
            recid,
            bibtex_preview: bibtex.slice(0, 240),
          });
        }
        if (expectedTexkey && citekey !== expectedTexkey) {
          throw invalidParams(`INSPIRE texkey mismatch for recid=${recid}`, {
            recid,
            expected_citekey: expectedTexkey,
            extracted_citekey: citekey,
          });
        }

        results.push({ recid, citekey, bibtex, links });
      }

      return { results };
    },
  },
];
