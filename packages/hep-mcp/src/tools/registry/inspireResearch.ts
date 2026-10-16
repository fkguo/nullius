import {
  INSPIRE_TOPIC_ANALYSIS,
  INSPIRE_NETWORK_ANALYSIS,
  INSPIRE_FIND_CONNECTIONS,
  INSPIRE_TRACE_ORIGINAL_SOURCE,
  INSPIRE_GRADE_EVIDENCE,
  INSPIRE_DETECT_MEASUREMENT_CONFLICTS,
  INSPIRE_CRITICAL_ANALYSIS,
  INSPIRE_CLASSIFY_REVIEWS,
  INSPIRE_THEORETICAL_CONFLICTS,
  INSPIRE_PARSE_LATEX,
  INSPIRE_PAPER_SOURCE,
  INSPIRE_FIND_CROSSOVER_TOPICS,
  INSPIRE_ANALYZE_CITATION_STANCE,
  INSPIRE_CLEANUP_DOWNLOADS,
  INSPIRE_VALIDATE_BIBLIOGRAPHY,
} from '@nullius/shared';
import { notFound } from '@nullius/shared';
import { OutputBatch, resolveOutputDir } from '../../core/outputDir.js';
import type { ToolSpec } from './types.js';
import {
  FindConnectionsToolSchema,
  InspireGradeEvidenceToolSchema,
  InspireDetectMeasurementConflictsToolSchema,
  InspireCriticalAnalysisToolSchema,
  InspireClassifyReviewsToolSchema,
  InspireTheoreticalConflictsToolSchema,
  TopicAnalysisToolSchema,
  NetworkAnalysisToolSchema,
  TraceOriginalSourceToolSchema,
  PaperSourceToolSchema,
  InspireParseLatexToolSchema,
  FindCrossoverTopicsToolSchema,
  AnalyzeCitationStanceToolSchema,
  CleanupDownloadsToolSchema,
  ValidateBibliographyToolSchema,
  hashParseLatexRequest,
  isNoLatexSourceError,
} from './inspireSchemas.js';

export const RAW_INSPIRE_RESEARCH_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  {
    name: INSPIRE_PARSE_LATEX,
    title: 'Parse paper LaTeX',
    tier: 'consolidated',
    exposure: 'standard',
    description:
      'Parse LaTeX content and extract selected components, writing `parse_latex_<hash>.json` into output_dir inside project_root (network; returns its project-relative path + summary).',
    zodSchema: InspireParseLatexToolSchema,
    handler: async (params, ctx) => {
      const { parseLatexContent } = await import('../research/parseLatexContent.js');
      // Options not given stay absent, so the parser's defaults apply to them.
      const options = params.options
        ? Object.fromEntries(Object.entries(params.options).filter(([, value]) => value !== undefined))
        : undefined;
      const hash = hashParseLatexRequest({
        identifier: params.identifier,
        components: params.components,
        options,
      });
      const artifactName = `parse_latex_${hash}.json`;
      const generatedAt = new Date().toISOString();
      const output = resolveOutputDir(params.output_dir);
      const batch = new OutputBatch(output);
      batch.reserve({ artifact_name: artifactName });

      try {
        const result = await parseLatexContent({
          identifier: params.identifier,
          components: params.components,
          options,
          ...(ctx.createMessage ? { _mcp: { createMessage: ctx.createMessage } } : {}),
        });

        const ref = batch.json(artifactName, {
          version: 1,
          generated_at: generatedAt,
          output_dir: output.relative,
          tool: INSPIRE_PARSE_LATEX,
          request: {
            identifier: params.identifier,
            components: params.components,
            options: options ?? null,
          },
          result,
        });
        await batch.publish();

        return {
          path: ref.path,
          summary: {
            artifact_name: ref.name,
            output_dir: output.relative,
            identifier: params.identifier,
            components: params.components,
            metadata: {
              arxiv_id: result.metadata.arxiv_id,
              source_file: result.metadata.source_file,
              title: result.metadata.title,
            },
            counts: result.summary.counts,
          },
        };
      } catch (err) {
        if (isNoLatexSourceError(err)) {
          const message = err instanceof Error ? err.message : String(err);
          throw batch.discard(notFound(message, {
            output_dir: output.relative,
            identifier: params.identifier,
            components: params.components,
          }));
        }
        throw batch.discard(err);
      }
    },
  },
  {
    name: INSPIRE_GRADE_EVIDENCE,
    title: 'Grade claim evidence',
    tier: 'consolidated',
    exposure: 'standard',
    maturity: 'stable',
    description: 'Grade evidence quality for a single paper\'s claims (network).',
    zodSchema: InspireGradeEvidenceToolSchema,
    handler: async (params, ctx) => {
      const { gradeEvidence } = await import('../research/evidenceGrading.js');
      return gradeEvidence(params, { createMessage: ctx.createMessage });
    },
  },
  {
    name: INSPIRE_DETECT_MEASUREMENT_CONFLICTS,
    title: 'Detect measurement conflicts',
    tier: 'consolidated',
    exposure: 'standard',
    maturity: 'stable',
    description: 'Detect measurement tensions across a bounded paper set (network).',
    zodSchema: InspireDetectMeasurementConflictsToolSchema,
    handler: async (params, ctx) => {
      const { detectConflicts } = await import('../research/conflictDetector.js');
      return detectConflicts(params, { createMessage: ctx.createMessage });
    },
  },
  {
    name: INSPIRE_CRITICAL_ANALYSIS,
    title: 'Critical paper analysis',
    tier: 'consolidated',
    exposure: 'standard',
    maturity: 'stable',
    description: 'Run bounded critical-analysis checks for a single paper (network).',
    zodSchema: InspireCriticalAnalysisToolSchema,
    handler: async (params, ctx) => {
      const { performCriticalAnalysis } = await import('../research/criticalAnalysis.js');
      return performCriticalAnalysis(params, { createMessage: ctx.createMessage });
    },
  },
  {
    name: INSPIRE_CLASSIFY_REVIEWS,
    title: 'Classify review papers',
    tier: 'consolidated',
    exposure: 'standard',
    maturity: 'stable',
    description: 'Classify review papers by scope and review type using semantic assessment (network).',
    zodSchema: InspireClassifyReviewsToolSchema,
    handler: async (params, ctx) => {
      const { classifyReviews } = await import('../research/reviewClassifier.js');
      return classifyReviews(params, { createMessage: ctx.createMessage });
    },
  },
  {
    name: INSPIRE_THEORETICAL_CONFLICTS,
    title: 'Theoretical conflicts map',
    tier: 'consolidated',
    exposure: 'standard',
    maturity: 'stable',
    description: 'Build a theoretical conflict map for a bounded paper set, writing every intermediate record and the map into output_dir inside project_root (network; MCP client sampling).',
    zodSchema: InspireTheoreticalConflictsToolSchema,
    handler: async (params, ctx) => {
      const { performTheoreticalConflicts } = await import('../research/theoreticalConflicts.js');
      return performTheoreticalConflicts(params, { createMessage: ctx.createMessage });
    },
  },
  {
    name: INSPIRE_TOPIC_ANALYSIS,
    title: 'INSPIRE topic analysis',
    tier: 'consolidated',
    exposure: 'standard',
    maturity: 'stable',
    description:
      'Unified topic analysis tool (network). Modes: timeline/evolution/emerging/all.',
    zodSchema: TopicAnalysisToolSchema,
    handler: async params => {
      const { analyzeTopicUnified } = await import('../research/topicAnalysis.js');
      return analyzeTopicUnified(params);
    },
  },
  {
    name: INSPIRE_NETWORK_ANALYSIS,
    title: 'Citation network analysis',
    tier: 'consolidated',
    exposure: 'standard',
    maturity: 'stable',
    description:
      'Unified network analysis tool (network). Modes: citation/collaboration.',
    zodSchema: NetworkAnalysisToolSchema,
    handler: async params => {
      const { analyzeNetwork } = await import('../research/networkAnalysis.js');
      return analyzeNetwork(params);
    },
  },
  {
    name: INSPIRE_FIND_CONNECTIONS,
    title: 'Find paper connections',
    tier: 'consolidated',
    exposure: 'standard',
    maturity: 'stable',
    description:
      'Find structural relationships inside a paper set (network): internal edges, bridge papers, isolated papers, and optional external hubs.',
    zodSchema: FindConnectionsToolSchema,
    handler: async params => {
      const { findConnections } = await import('../research/findConnections.js');
      return findConnections(params);
    },
  },
  {
    name: INSPIRE_TRACE_ORIGINAL_SOURCE,
    title: 'Trace original source',
    tier: 'consolidated',
    exposure: 'standard',
    maturity: 'stable',
    description:
      'Trace citation chains to identify likely original sources behind a paper (network).',
    zodSchema: TraceOriginalSourceToolSchema,
    handler: async params => {
      const { traceOriginalSource } = await import('../research/traceSource.js');
      return traceOriginalSource(params);
    },
  },
  {
    name: INSPIRE_PAPER_SOURCE,
    title: 'INSPIRE paper source',
    tier: 'consolidated',
    exposure: 'standard',
    description: `Unified paper source access tool (network). Modes: urls/content/metadata/auto (downloads arXiv sources/PDFs and optionally extracts).

- 'urls': Only return download URLs without downloading (fast check)
- 'content': Actually download and extract paper source (LaTeX or PDF). Use this mode to download arXiv LaTeX source.
- 'metadata': Get arXiv metadata and source availability info
- 'auto': Get URLs first with availability check, but does NOT automatically download

To download arXiv LaTeX source, use mode='content' with options.prefer='latex' and options.extract=true.

Safety: if you set options.output_dir, it must be within HEP_DATA_DIR. Prefer a relative output_dir (e.g. "arxiv_sources/<arxiv_id>"); relative paths are resolved under HEP_DATA_DIR. Or set HEP_DATA_DIR to change the root.`,
    zodSchema: PaperSourceToolSchema,
    handler: async params => {
      const path = await import('path');
      const { resolveArxivIdRich } = await import('../../utils/resolveArxivId.js');
      const resolved = await resolveArxivIdRich(params.identifier);
      if (!resolved.arxivId) {
        if (params.mode === 'urls' || params.mode === 'auto') {
          return {
            mode: params.mode,
            identifier: params.identifier,
            provenance: { downloaded: false, retrieval_level: 'urls_only' },
            urls: {
              has_source: false,
              source_available: null,
              ...(resolved.doi ? { doi_url: `https://doi.org/${resolved.doi}` } : {}),
              ...(resolved.recid ? { inspire_url: `https://inspirehep.net/literature/${resolved.recid}` } : {}),
            },
          };
        }
        if (params.mode === 'content') {
          return {
            mode: params.mode,
            identifier: params.identifier,
            provenance: { downloaded: false, retrieval_level: 'none' },
            content: {
              success: false,
              source_type: 'pdf',
              file_path: '',
              arxiv_id: '',
              error: `Could not resolve arXiv ID for: ${params.identifier}`,
            },
          };
        }
        if (params.mode === 'metadata') {
          return {
            mode: params.mode,
            identifier: params.identifier,
            provenance: { downloaded: false, retrieval_level: 'none', source_available: null },
            urls: {
              has_source: false,
              source_available: null,
              ...(resolved.doi ? { doi_url: `https://doi.org/${resolved.doi}` } : {}),
              ...(resolved.recid ? { inspire_url: `https://inspirehep.net/literature/${resolved.recid}` } : {}),
            },
            error: `Could not resolve arXiv ID for: ${params.identifier}`,
          };
        }
        throw new Error(`Could not resolve "${params.identifier}" to an arXiv ID`);
      }
      const { auto_cleanup, output_dir: _outputDir, ...arxivOptions } = params.options ?? {};
      if (params.mode === 'content') {
        const { resolvePathWithinParent } = await import('../../data/pathGuard.js');
        const { getDataDir, getDownloadsDir } = await import('../../data/dataDir.js');
        const outputDir = params.options?.output_dir
          ? resolvePathWithinParent(getDataDir(), params.options.output_dir, 'output_dir')
          : getDownloadsDir();
        const destDir = path.join(outputDir, `arxiv-${resolved.arxivId.replace('/', '-')}`);
        const fs = await import('fs');
        fs.mkdirSync(destDir, { recursive: true });
        const { writeDirectoryMarker } = await import('../../data/markers.js');
        writeDirectoryMarker(destDir, 'download_dir');
        if (auto_cleanup) {
          const { registerDownloadDir } = await import('../../data/downloadSession.js');
          registerDownloadDir(destDir);
        }
        const { accessPaperSource } = await import('@nullius/arxiv-mcp/tooling');
        const result = await accessPaperSource({
          identifier: resolved.arxivId,
          mode: params.mode,
          options: { ...arxivOptions, output_dir: outputDir },
        });
        result.identifier = params.identifier;
        return result;
      }
      const { accessPaperSource } = await import('@nullius/arxiv-mcp/tooling');
      const result = await accessPaperSource({
        identifier: resolved.arxivId,
        mode: params.mode,
        options: arxivOptions,
      });
      result.identifier = params.identifier;
      if ((params.mode === 'urls' || params.mode === 'auto') && result.urls) {
        const urls = result.urls as unknown as Record<string, unknown>;
        if (resolved.recid) urls.inspire_url = `https://inspirehep.net/literature/${resolved.recid}`;
        if (resolved.doi) urls.doi_url = `https://doi.org/${resolved.doi}`;
      }
      return result;
    },
  },
  {
    name: INSPIRE_FIND_CROSSOVER_TOPICS,
    title: 'Find crossover topics',
    tier: 'advanced',
    exposure: 'full',
    description:
      'Discover emerging interdisciplinary research areas by analyzing papers spanning multiple arXiv categories (network).',
    zodSchema: FindCrossoverTopicsToolSchema,
    handler: async params => {
      const { findCrossoverTopics } = await import('../research/crossoverTopics.js');
      return findCrossoverTopics(params);
    },
  },
  {
    name: INSPIRE_ANALYZE_CITATION_STANCE,
    title: 'Citation stance analysis',
    tier: 'advanced',
    exposure: 'full',
    description:
      'Analyze how a paper cites another paper (stance detection; resolves citekeys via INSPIRE as needed; network).',
    zodSchema: AnalyzeCitationStanceToolSchema,
    handler: async params => {
      const { analyzeStanceFromLatex } = await import('../research/stance/index.js');
      return analyzeStanceFromLatex({
        latexContent: params.latex_content,
        targetRecid: params.target_recid,
        bibContent: params.bib_content,
        options: { maxContexts: params.max_contexts },
      });
    },
  },
  {
    name: INSPIRE_CLEANUP_DOWNLOADS,
    title: 'Clean up downloads',
    tier: 'advanced',
    exposure: 'full',
    description:
      'Delete cached arXiv source download directories created by this server (marker-checked). Supports `dry_run`, `older_than_hours`, and `arxiv_id` filtering (local-only).',
    zodSchema: CleanupDownloadsToolSchema,
    handler: async params => {
      const { cleanupDownloads } = await import('../research/cleanupDownloads.js');
      return cleanupDownloads(params);
    },
  },
  {
    name: INSPIRE_VALIDATE_BIBLIOGRAPHY,
    title: 'Validate bibliography',
    tier: 'advanced',
    exposure: 'full',
    description:
      'Usability-first bibliography audit for a paper (default: manual non-INSPIRE entries only). Optionally cross-validate against INSPIRE; warnings are non-blocking (network for INSPIRE mode).',
    zodSchema: ValidateBibliographyToolSchema,
    handler: async params => {
      const { validateBibliography } = await import('../research/validateBibliography.js');
      return validateBibliography(params);
    },
  },
];
