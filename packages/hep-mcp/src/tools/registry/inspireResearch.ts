import {
  INSPIRE_PARSE_LATEX,
  INSPIRE_RESEARCH_NAVIGATOR,
  INSPIRE_CRITICAL_RESEARCH,
  INSPIRE_PAPER_SOURCE,
  INSPIRE_DEEP_RESEARCH,
  INSPIRE_FIND_CROSSOVER_TOPICS,
  INSPIRE_ANALYZE_CITATION_STANCE,
  INSPIRE_CLEANUP_DOWNLOADS,
  INSPIRE_VALIDATE_BIBLIOGRAPHY,
} from '@autoresearch/shared';
import { notFound } from '@autoresearch/shared';
import { formatExpertsMarkdown } from '../../utils/formatters.js';
import { writeRunJsonArtifact } from '../../core/citations.js';
import { deepResearchAnalyzeNextActions, discoveryNextActions, withNextActions } from '../utils/discoveryHints.js';
import type { ToolSpec } from './types.js';
import {
  ResearchNavigatorToolSchema,
  CriticalResearchToolSchema,
  PaperSourceToolSchema,
  DeepResearchToolSchema,
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
    tier: 'consolidated',
    exposure: 'standard',
    description:
      'Parse LaTeX content and extract selected components into a run artifact (Evidence-first; writes `parse_latex_<hash>.json`; network).',
    zodSchema: InspireParseLatexToolSchema,
    handler: async (params, ctx) => {
      const { parseLatexContent } = await import('../research/parseLatexContent.js');
      const hash = hashParseLatexRequest({
        identifier: params.identifier,
        components: params.components,
        options: params.options,
      });
      const artifactName = `parse_latex_${hash}.json`;
      const generatedAt = new Date().toISOString();

      try {
        const result = await parseLatexContent({
          identifier: params.identifier,
          components: params.components,
          options: params.options,
          ...(ctx.createMessage ? { _mcp: { createMessage: ctx.createMessage } } : {}),
        });

        const ref = writeRunJsonArtifact(params.run_id, artifactName, {
          version: 1,
          generated_at: generatedAt,
          run_id: params.run_id,
          tool: INSPIRE_PARSE_LATEX,
          request: {
            identifier: params.identifier,
            components: params.components,
            options: params.options ?? null,
          },
          result,
        });

        return {
          uri: ref.uri,
          summary: {
            artifact_name: ref.name,
            run_id: params.run_id,
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
          throw notFound(message, {
            run_id: params.run_id,
            identifier: params.identifier,
            components: params.components,
          });
        }
        throw err;
      }
    },
  },
  {
    name: INSPIRE_RESEARCH_NAVIGATOR,
    tier: 'consolidated',
    exposure: 'standard',
    intent: 'paper_discovery',
    maturity: 'stable',
    description:
      'Unified research navigation tool (network). Modes: discover/field_survey/topic_analysis/network/experts/connections/trace_source/analyze.',
    zodSchema: ResearchNavigatorToolSchema,
    handler: async (params, ctx) => {
      const result = await (async () => {
        switch (params.mode) {
          case 'discover': {
            const { discoverPapers } = await import('../research/discoverPapers.js');
            return discoverPapers({
              mode: params.discover_mode!,
              topic: params.topic,
              seed_recids: params.seed_recids,
              limit: params.limit,
              options: params.discover_options,
            });
          }
          case 'field_survey': {
            const { performFieldSurvey } = await import('../research/fieldSurvey.js');
            return performFieldSurvey({
              topic: params.topic!,
              seed_recid: params.seed_recid,
              iterations: params.iterations,
              max_papers: params.limit,
              focus: params.focus,
              prefer_journal: params.prefer_journal,
              ...(ctx.createMessage ? { _mcp: { createMessage: ctx.createMessage } } : {}),
            });
          }
          case 'topic_analysis': {
            const { analyzeTopicUnified } = await import('../research/topicAnalysis.js');
            return analyzeTopicUnified({
              topic: params.topic!,
              mode: params.topic_mode!,
              time_range: params.time_range,
              limit: params.limit,
              options: params.topic_options,
            });
          }
          case 'network': {
            const { analyzeNetwork } = await import('../research/networkAnalysis.js');
            return analyzeNetwork({
              mode: params.network_mode!,
              seed: params.seed!,
              limit: params.limit,
              options: params.network_options,
            });
          }
          case 'experts': {
            const { findExperts } = await import('../research/experts.js');
            const res = await findExperts({ topic: params.topic!, limit: params.limit ?? 10 });
            if (params.format === 'markdown') {
              return formatExpertsMarkdown(res.topic, res.experts);
            }
            return res;
          }
          case 'connections': {
            const { findConnections } = await import('../research/findConnections.js');
            const recids = params.seed_recids ?? (params.seed ? [params.seed] : []);
            return findConnections({
              recids,
              include_external: params.include_external,
              max_external_depth: params.max_external_depth,
            });
          }
          case 'trace_source': {
            const { traceOriginalSource } = await import('../research/traceSource.js');
            const recid = params.seed ?? params.seed_recids?.[0];
            return traceOriginalSource({
              recid: recid!,
              max_depth: params.max_depth,
              max_refs_per_level: params.max_refs_per_level,
              cross_validate: params.cross_validate,
            });
          }
          case 'analyze': {
            const { analyzePapers } = await import('../research/analyzePapers.js');
            const recids = params.recids ?? params.seed_recids ?? (params.seed ? [params.seed] : []);
            return analyzePapers({ recids, analysis_type: params.analysis_type });
          }
          default:
            throw new Error(`Unknown inspire_research_navigator mode: ${String((params as { mode?: unknown }).mode)}`);
        }
      })();
      const papers = result && typeof result === 'object' && 'papers' in result
        ? (result as Record<string, unknown>).papers
        : undefined;
      return withNextActions(result, discoveryNextActions(papers));
    },
  },
  {
    name: INSPIRE_CRITICAL_RESEARCH,
    tier: 'consolidated',
    exposure: 'standard',
    description:
      'Unified critical research tool (network). Modes: evidence/conflicts/analysis/reviews/theoretical. internal mode uses MCP sampling (createMessage) provided by the MCP client. NOT FOR broad paper discovery/navigation; use inspire_research_navigator for discovery workflows.',
    zodSchema: CriticalResearchToolSchema,
    handler: async (params, ctx) => {
      const { performCriticalResearch } = await import('../research/criticalResearch.js');
      const result = await performCriticalResearch(params, {
        createMessage: ctx.createMessage,
      });

      if ((params.mode === 'evidence' || params.mode === 'analysis') && params.run_id) {
        const artifactName = `critical_${params.mode}_result.json`;
        const ref = writeRunJsonArtifact(params.run_id, artifactName, { version: 1, ...result });
        const modeResult = result && typeof result === 'object'
          ? (result as unknown as Record<string, unknown>)[params.mode] as Record<string, unknown> | undefined
          : undefined;

        const summary: Record<string, unknown> = { mode: params.mode };
        if (params.mode === 'evidence' && modeResult) {
          summary.claim_count = modeResult.claim_count ?? modeResult.total_claims ?? 0;
          summary.grade_distribution = modeResult.grade_distribution ?? {};
        }
        if (params.mode === 'analysis' && modeResult) {
          summary.assumption_count = modeResult.assumption_count ?? 0;
          summary.open_question_count = modeResult.open_question_count ?? 0;
        }

        return { artifact_uri: ref.uri, summary };
      }

      return result;
    },
  },
  {
    name: INSPIRE_PAPER_SOURCE,
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
        const { accessPaperSource } = await import('@autoresearch/arxiv-mcp/tooling');
        const result = await accessPaperSource({
          identifier: resolved.arxivId,
          mode: params.mode,
          options: { ...arxivOptions, output_dir: outputDir },
        });
        result.identifier = params.identifier;
        return result;
      }
      const { accessPaperSource } = await import('@autoresearch/arxiv-mcp/tooling');
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
    name: INSPIRE_DEEP_RESEARCH,
    tier: 'consolidated',
    exposure: 'standard',
    description:
      'End-to-end deep research pipeline over a paper set. Modes: analyze/synthesize. NOT FOR lightweight discovery-only requests; use inspire_research_navigator for discovery workflows.',
    zodSchema: DeepResearchToolSchema,
    handler: async (params, ctx) => {
      const { performDeepResearch } = await import('../research/deepResearch.js');
      const result = await performDeepResearch({
        ...params,
        ...((ctx.reportProgress || ctx.createMessage)
          ? {
            _mcp: {
              ...(ctx.reportProgress ? { reportProgress: ctx.reportProgress } : {}),
              ...(ctx.createMessage ? { createMessage: ctx.createMessage } : {}),
            },
          }
          : {}),
      });

      if (params.mode === 'analyze' && params.run_id) {
        const ref = writeRunJsonArtifact(params.run_id, 'deep_analyze_result_v1.json', { version: 1, ...result });
        const analysis = result && typeof result === 'object' && 'analysis' in result
          ? (result as unknown as Record<string, unknown>).analysis as Record<string, unknown> | undefined
          : undefined;
        return {
          artifact_uri: ref.uri,
          summary: {
            paper_count: analysis?.paper_count ?? (Array.isArray(params.identifiers) ? params.identifiers.length : 0),
            equations_found: analysis?.equations_found ?? analysis?.total_equations ?? 0,
            key_findings: Array.isArray(analysis?.key_findings) ? (analysis.key_findings as unknown[]).slice(0, 3) : [],
          },
          next_actions: deepResearchAnalyzeNextActions(params.identifiers),
        };
      }

      if (params.mode === 'synthesize' && params.run_id) {
        const ref = writeRunJsonArtifact(params.run_id, 'deep_synthesize_result_v1.json', { version: 1, ...result });
        const review = result && typeof result === 'object' && 'review' in result
          ? (result as unknown as Record<string, unknown>).review as Record<string, unknown> | undefined
          : undefined;
        return {
          artifact_uri: ref.uri,
          summary: {
            theme_count: review?.theme_count ?? review?.total_themes ?? 0,
            paper_count: review?.paper_count ?? (Array.isArray(params.identifiers) ? params.identifiers.length : 0),
            open_questions: Array.isArray(review?.open_questions) ? (review.open_questions as unknown[]).slice(0, 5) : [],
          },
        };
      }

      if (params.mode === 'analyze') {
        return withNextActions(result, deepResearchAnalyzeNextActions(params.identifiers));
      }
      return result;
    },
  },
  {
    name: INSPIRE_FIND_CROSSOVER_TOPICS,
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
