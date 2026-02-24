/**
 * Paper Source Tool (Consolidated)
 * Combines: get_download_urls, get_paper_content, get_arxiv_source
 *
 * Modes:
 * - 'urls': Get download URLs without downloading
 * - 'content': Download paper content (LaTeX/PDF)
 * - 'metadata': Get arXiv metadata and source info
 * - 'auto': Smart mode - get URLs first, download if needed
 */

import { getDownloadUrls, type GetDownloadUrlsResult } from './downloadUrls.js';
import { getPaperContent, type GetPaperContentResult } from './paperContent.js';
import { getArxivSource, type ArxivSourceResult } from './arxivSource.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SourceMode = 'urls' | 'content' | 'metadata' | 'auto';

export interface PaperSourceParams {
  /** Paper identifier: recid, arXiv ID, or DOI */
  identifier: string;
  /** Access mode */
  mode: SourceMode;
  /** Mode-specific options */
  options?: SourceOptions;
}

export interface SourceOptions {
  // Content options
  prefer?: 'latex' | 'pdf' | 'auto';
  extract?: boolean;
  auto_cleanup?: boolean;
  output_dir?: string;

  // URLs options
  check_availability?: boolean;
}

export interface PaperSourceResult {
  mode: SourceMode;
  identifier: string;
  /**
   * Retrieval provenance (top-level; reduces LLM ambiguity about what was actually fetched).
   *
   * Invariant: `downloaded=true` only when `retrieval_level` is `latex_source` or `pdf_only`.
   */
  provenance: {
    downloaded: boolean;
    retrieval_level: 'none' | 'urls_only' | 'metadata_only' | 'latex_source' | 'pdf_only';
    /** Source availability probe result (when applicable). */
    source_available?: boolean | null;
  };
  /** Download URLs (if mode='urls' or 'auto') */
  urls?: GetDownloadUrlsResult;
  /** Paper content (if mode='content') */
  content?: GetPaperContentResult;
  /** arXiv metadata (if mode='metadata') */
  metadata?: ArxivSourceResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unified paper source access tool
 */
export async function accessPaperSource(
  params: PaperSourceParams
): Promise<PaperSourceResult> {
  const { identifier, mode, options = {} } = params;

  const result: PaperSourceResult = {
    mode,
    identifier,
    provenance: {
      downloaded: false,
      retrieval_level: 'none',
    },
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
        auto_cleanup: options.auto_cleanup,
        output_dir: options.output_dir,
      });
      break;
    }

    case 'metadata': {
      result.metadata = await getArxivSource({ identifier });
      break;
    }

    case 'auto': {
      // First get URLs to check availability
      result.urls = await getDownloadUrls({
        identifier,
        check_availability: true,
      });
      break;
    }

    default:
      throw new Error(`Unknown mode: ${mode}`);
  }

  // Build top-level provenance to make toolflow state explicit (esp. for LLM callers).
  result.provenance = (() => {
    if (mode === 'urls' || mode === 'auto') {
      return {
        downloaded: false,
        retrieval_level: 'urls_only',
        source_available: result.urls?.source_available,
      };
    }

    if (mode === 'metadata') {
      return {
        downloaded: false,
        retrieval_level: 'metadata_only',
      };
    }

    if (mode === 'content') {
      const c = result.content;
      if (c?.success && c.source_type === 'latex') {
        return {
          downloaded: true,
          retrieval_level: 'latex_source',
          source_available: true,
        };
      }
      if (c?.success && c.source_type === 'pdf') {
        return {
          downloaded: true,
          retrieval_level: 'pdf_only',
        };
      }
      return {
        downloaded: false,
        retrieval_level: 'none',
      };
    }

    return {
      downloaded: false,
      retrieval_level: 'none',
    };
  })();

  return result;
}
