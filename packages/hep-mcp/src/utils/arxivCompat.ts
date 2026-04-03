/**
 * arxivCompat — INSPIRE-aware wrappers around @autoresearch/arxiv-mcp functions
 *
 * hep-mcp callers that receive mixed identifiers (recid/DOI/arXiv ID) use these
 * wrappers instead of importing directly from arxiv-mcp.
 */

import { getPaperContent as _getPaperContent } from '@autoresearch/arxiv-mcp/tooling';
import { accessPaperSource as _accessPaperSource } from '@autoresearch/arxiv-mcp/tooling';
import type { GetPaperContentParams } from '@autoresearch/arxiv-mcp/tooling';
import type { PaperSourceParams as ArxivPaperSourceParams } from '@autoresearch/arxiv-mcp/tooling';
import { resolveArxivId } from './resolveArxivId.js';

/** hep-mcp extends arxiv-mcp's PaperSourceParams with INSPIRE-specific options */
interface PaperSourceParamsCompat extends Omit<ArxivPaperSourceParams, 'options'> {
  options?: ArxivPaperSourceParams['options'] & { auto_cleanup?: boolean };
}

/** getPaperContent with INSPIRE resolution for mixed identifiers */
export async function getPaperContent(params: GetPaperContentParams) {
  const arxivId = await resolveArxivId(params.identifier);
  if (!arxivId) {
    return { success: false, source_type: 'pdf' as const, file_path: '', arxiv_id: '',
      error: `Could not resolve arXiv ID for: ${params.identifier}` };
  }
  return _getPaperContent({ ...params, identifier: arxivId });
}

/** accessPaperSource with INSPIRE resolution + mode-aware structured failures */
export async function accessPaperSource(params: PaperSourceParamsCompat) {
  const arxivId = await resolveArxivId(params.identifier);
  if (!arxivId) {
    if (params.mode === 'urls' || params.mode === 'auto') {
      return { mode: params.mode, identifier: params.identifier,
        provenance: { downloaded: false, retrieval_level: 'urls_only' as const },
        urls: { has_source: false, source_available: null } };
    }
    if (params.mode === 'content') {
      return { mode: params.mode, identifier: params.identifier,
        provenance: { downloaded: false, retrieval_level: 'none' as const },
        content: { success: false, source_type: 'pdf' as const, file_path: '', arxiv_id: '',
          error: `Could not resolve arXiv ID for: ${params.identifier}` } };
    }
    if (params.mode === 'metadata') {
      return {
        mode: params.mode,
        identifier: params.identifier,
        provenance: { downloaded: false, retrieval_level: 'none' as const, source_available: null },
        urls: { has_source: false, source_available: null },
        error: `Could not resolve arXiv ID for: ${params.identifier}`,
      };
    }
    throw new Error(`Could not resolve "${params.identifier}" to an arXiv ID`);
  }
  const { auto_cleanup, ...arxivOptions } = params.options ?? {};
  const result = await _accessPaperSource({ ...params, identifier: arxivId, options: arxivOptions });
  result.identifier = params.identifier;
  return result;
}

// Re-export types for convenience
export type { GetPaperContentParams };
