/**
 * Paper Source — unified mode-based routing (urls/content/metadata/auto)
 *
 * Domain-agnostic: no INSPIRE dependency.
 */

import { normalizeArxivId, getArxivSource, type ArxivSourceResult } from './arxivSource.js';
import { getDownloadUrls, type GetDownloadUrlsResult } from './downloadUrls.js';
import { getPaperContent, type GetPaperContentResult } from './paperContent.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SourceMode = 'urls' | 'content' | 'metadata' | 'auto';

export interface SourceOptions {
  prefer?: 'latex' | 'pdf' | 'auto';
  extract?: boolean;
  output_dir?: string;
  check_availability?: boolean;
}

export interface PaperSourceParams {
  identifier: string;
  mode: SourceMode;
  options?: SourceOptions;
}

export interface PaperSourceResult {
  mode: SourceMode;
  identifier: string;
  provenance: {
    downloaded: boolean;
    retrieval_level: 'none' | 'urls_only' | 'metadata_only' | 'latex_source' | 'pdf_only';
    source_available?: boolean | null;
  };
  urls?: GetDownloadUrlsResult;
  content?: GetPaperContentResult;
  metadata?: ArxivSourceResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified paper source access.
 * Identifier must be a valid arXiv ID (use normalizeArxivId).
 */
export async function accessPaperSource(
  params: PaperSourceParams
): Promise<PaperSourceResult> {
  const { identifier, mode, options = {} } = params;

  const result: PaperSourceResult = {
    mode,
    identifier,
    provenance: { downloaded: false, retrieval_level: 'none' },
  };

  switch (mode) {
    case 'urls': {
      result.urls = await getDownloadUrls({
        identifier,
        check_availability: options.check_availability,
      });
      break;
    }

    case 'content': {
      result.content = await getPaperContent({
        identifier,
        prefer: options.prefer,
        extract: options.extract,
        output_dir: options.output_dir,
      });
      break;
    }

    case 'metadata': {
      const arxivId = normalizeArxivId(identifier);
      if (!arxivId) throw new Error(`Invalid arXiv ID: ${identifier}`);
      result.metadata = await getArxivSource(arxivId);
      break;
    }

    case 'auto': {
      result.urls = await getDownloadUrls({
        identifier,
        check_availability: true,
      });
      break;
    }

    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  // Build provenance
  result.provenance = buildProvenance(mode, result);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance Builder
// ─────────────────────────────────────────────────────────────────────────────

function buildProvenance(
  mode: SourceMode,
  result: PaperSourceResult
): PaperSourceResult['provenance'] {
  if (mode === 'urls' || mode === 'auto') {
    return {
      downloaded: false,
      retrieval_level: 'urls_only',
      source_available: result.urls?.source_available,
    };
  }

  if (mode === 'metadata') {
    return { downloaded: false, retrieval_level: 'metadata_only' };
  }

  if (mode === 'content') {
    const c = result.content;
    if (c?.success && c.source_type === 'latex') {
      return { downloaded: true, retrieval_level: 'latex_source', source_available: true };
    }
    if (c?.success && c.source_type === 'pdf') {
      return { downloaded: true, retrieval_level: 'pdf_only' };
    }
    return { downloaded: false, retrieval_level: 'none' };
  }

  return { downloaded: false, retrieval_level: 'none' };
}
