import {
  HEP_PROJECT_CREATE,
  HEP_PROJECT_GET,
  HEP_PROJECT_LIST,
  HEP_HEALTH,
  HEP_PROJECT_BUILD_EVIDENCE,
  HEP_PROJECT_QUERY_EVIDENCE,
  HEP_PROJECT_QUERY_EVIDENCE_SEMANTIC,
  HEP_PROJECT_PLAYBACK_EVIDENCE,
  HEP_PROJECT_COMPARE_MEASUREMENTS,
  HEP_RUN_CREATE,
  HEP_RUN_READ_ARTIFACT_CHUNK,
  HEP_RUN_CLEAR_MANIFEST_LOCK,
  HEP_RUN_STAGE_CONTENT,
  HEP_RUN_BUILD_PDF_EVIDENCE,
  HEP_RUN_BUILD_WRITING_EVIDENCE,
  HEP_RUN_BUILD_MEASUREMENTS,
  HEP_RENDER_LATEX,
  HEP_EXPORT_PROJECT,
  HEP_EXPORT_PAPER_SCAFFOLD,
  HEP_IMPORT_PAPER_BUNDLE,
  HEP_INSPIRE_SEARCH_EXPORT,
  HEP_INSPIRE_RESOLVE_IDENTIFIERS,
} from '@autoresearch/shared';
import { createProject, getProject, listProjects } from '../../core/projects.js';
import { createRun } from '../../core/runs.js';
import { buildProjectEvidenceCatalog, playbackProjectEvidence, queryProjectEvidence } from '../../core/evidence.js';
import { renderLatexForRun } from '../../core/writing/renderLatex.js';
import { buildRunPdfEvidence } from '../../core/pdf/evidence.js';
import { exportProjectForRun } from '../../core/export/exportProject.js';
import { exportPaperScaffoldForRun } from '../../core/export/exportPaperScaffold.js';
import { importPaperBundleForRun } from '../../core/export/importPaperBundle.js';
import { hepInspireSearchExport } from '../../core/inspire/searchExport.js';
import { hepInspireResolveIdentifiers } from '../../core/inspire/resolveIdentifiers.js';
import { buildRunMeasurements } from '../../core/hep/measurements.js';
import { compareProjectMeasurements } from '../../core/hep/compareMeasurements.js';
import { getHepHealth } from '../utils/health.js';
import type { ToolSpec } from './types.js';
import {
  HepProjectCreateToolSchema,
  HepProjectGetToolSchema,
  HepProjectListToolSchema,
  HepHealthToolSchema,
  HepRunCreateToolSchema,
  HepRunReadArtifactChunkToolSchema,
  HepRunClearManifestLockToolSchema,
  HepRunStageContentToolSchema,
  HepRunBuildWritingEvidenceToolSchema,
  HepRunBuildMeasurementsToolSchema,
  HepProjectCompareMeasurementsToolSchema,
  HepRenderLatexToolSchema,
  HepExportProjectToolSchema,
  HepExportPaperScaffoldToolSchema,
  HepImportPaperBundleToolSchema,
  HepRunBuildPdfEvidenceToolSchema,
  HepInspireSearchExportToolSchema,
  HepInspireResolveIdentifiersToolSchema,
  HepProjectBuildEvidenceToolSchema,
  HepProjectQueryEvidenceToolSchema,
  HepProjectQueryEvidenceSemanticToolSchema,
  HepProjectPlaybackEvidenceToolSchema,
} from './projectSchemas.js';

export const RAW_PROJECT_CORE_TOOL_SPECS: Omit<ToolSpec, 'riskLevel'>[] = [
  {
    name: HEP_PROJECT_CREATE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a local project (Project/Run foundation) and return `hep://projects/{project_id}` (read details via MCP resources; local-only)',
    zodSchema: HepProjectCreateToolSchema,
    handler: async params => {
      const project = createProject(params);
      return {
        project_id: project.project_id,
        project_uri: `hep://projects/${encodeURIComponent(project.project_id)}`,
        summary: {
          name: project.name,
          description: project.description,
          created_at: project.created_at,
        },
      };
    },
  },
  {
    name: HEP_PROJECT_GET,
    tier: 'core',
    exposure: 'standard',
    description:
      'Get a project summary + `hep://projects/{project_id}` URI (read the full manifest via MCP resources; local-only)',
    zodSchema: HepProjectGetToolSchema,
    handler: async params => {
      const project = getProject(params.project_id);
      return {
        project_id: project.project_id,
        project_uri: `hep://projects/${encodeURIComponent(project.project_id)}`,
        summary: {
          name: project.name,
          description: project.description,
          created_at: project.created_at,
          updated_at: project.updated_at,
        },
      };
    },
  },
  {
    name: HEP_PROJECT_LIST,
    tier: 'core',
    exposure: 'standard',
    description:
      'List local projects (small summaries + `hep://projects/{project_id}` URIs; read details via MCP resources; local-only)',
    zodSchema: HepProjectListToolSchema,
    handler: async () => {
      const projects = listProjects().map(p => ({
        project_id: p.project_id,
        name: p.name,
        updated_at: p.updated_at,
        project_uri: `hep://projects/${encodeURIComponent(p.project_id)}`,
      }));
      return { total: projects.length, projects };
    },
  },
  {
    name: HEP_HEALTH,
    tier: 'core',
    exposure: 'standard',
    description:
      'Server health/config snapshot + optional INSPIRE connectivity probe (local-only; network optional).',
    zodSchema: HepHealthToolSchema,
    handler: async params =>
      getHepHealth({ check_inspire: params.check_inspire, inspire_timeout_ms: params.inspire_timeout_ms }),
  },
  {
    name: HEP_PROJECT_BUILD_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build a LaTeX Evidence Catalog for a project paper and write `catalog.jsonl` (Evidence-first: URI + summary; local-only)',
    zodSchema: HepProjectBuildEvidenceToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const maxParagraphLengthProvided = Object.prototype.hasOwnProperty.call(raw, 'max_paragraph_length');
      return buildProjectEvidenceCatalog({ ...params, budget_hints: { max_paragraph_length_provided: maxParagraphLengthProvided } });
    },
  },
  {
    name: HEP_PROJECT_QUERY_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Unified query over a project Evidence Catalog (mode=lexical|semantic; semantic requires run embeddings and writes run artifact; local-only).',
    zodSchema: HepProjectQueryEvidenceToolSchema,
    handler: async (params, ctx) => {
      if (params.mode === 'semantic') {
        const { queryProjectEvidenceSemantic } = await import('../../core/evidenceSemantic.js');
        return queryProjectEvidenceSemantic({
          run_id: params.run_id!,
          project_id: params.project_id,
          paper_id: params.paper_id,
          query: params.query,
          types: params.types,
          include_explanation: params.include_explanation,
          limit: params.limit,
        });
      }

      const raw = ctx.rawArgs ?? {};
      const concurrencyProvided = Object.prototype.hasOwnProperty.call(raw, 'concurrency');
      return queryProjectEvidence({
        project_id: params.project_id,
        paper_id: params.paper_id,
        query: params.query,
        types: params.types,
        limit: params.limit,
        concurrency: params.concurrency,
        budget_hints: { concurrency_provided: concurrencyProvided },
      });
    },
  },
  {
    name: HEP_PROJECT_QUERY_EVIDENCE_SEMANTIC,
    tier: 'core',
    exposure: 'standard',
    description:
      'Semantic query interface for a project Evidence Catalog. Currently falls back to lexical search and writes a run artifact (URI + summary; local-only).',
    zodSchema: HepProjectQueryEvidenceSemanticToolSchema,
    handler: async params => {
      const { queryProjectEvidenceSemantic } = await import('../../core/evidenceSemantic.js');
      return queryProjectEvidenceSemantic(params);
    },
  },
  {
    name: HEP_PROJECT_PLAYBACK_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description: 'Playback an evidence locator and return a stable snippet (local-only)',
    zodSchema: HepProjectPlaybackEvidenceToolSchema,
    handler: async params => playbackProjectEvidence(params),
  },
  {
    name: HEP_RUN_CREATE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Create a run under a project (writes run manifest + artifacts dir; returns `hep://runs/{run_id}` URIs; local-only)',
    zodSchema: HepRunCreateToolSchema,
    handler: async params => {
      const { manifest, artifacts } = createRun({
        project_id: params.project_id,
        args_snapshot: params.args_snapshot,
      });
      return {
        run_id: manifest.run_id,
        project_id: manifest.project_id,
        manifest_uri: `hep://runs/${encodeURIComponent(manifest.run_id)}/manifest`,
        artifacts,
        summary: {
          status: manifest.status,
          created_at: manifest.created_at,
        },
      };
    },
  },
  {
    name: HEP_RUN_READ_ARTIFACT_CHUNK,
    tier: 'core',
    exposure: 'standard',
    description:
      'Read a small byte-range chunk from a HEP run artifact (debug helper; returns base64 chunk; local-only). ' +
      'Note: This tool only works for HEP run artifacts (hep://runs/...). ' +
      'For PDG artifacts (pdg://artifacts/...), use MCP Resources (ReadResource request) instead.',
    zodSchema: HepRunReadArtifactChunkToolSchema,
    handler: async params => {
      const { readRunArtifactChunk } = await import('../../core/artifactChunk.js');
      return readRunArtifactChunk({
        run_id: params.run_id,
        artifact_name: params.artifact_name,
        offset: params.offset,
        length: params.length,
      });
    },
  },
  {
    name: HEP_RUN_CLEAR_MANIFEST_LOCK,
    tier: 'core',
    exposure: 'standard',
    description:
      'Clear a stale run manifest lock file (fail-fast; local-only). Use force=true only if you are sure no other tool is updating the run manifest.',
    zodSchema: HepRunClearManifestLockToolSchema,
    handler: async params => {
      const { clearRunManifestLock } = await import('../../core/runs.js');
      return clearRunManifestLock({ run_id: params.run_id, force: params.force });
    },
  },
  {
    name: HEP_RUN_STAGE_CONTENT,
    tier: 'core',
    exposure: 'standard',
    description:
      'Stage large client content into a run artifact and return its URI (token-limit safe two-step submission; local-only)',
    zodSchema: HepRunStageContentToolSchema,
    handler: async params => {
      const { stageRunContent } = await import('../../core/writing/staging.js');
      return stageRunContent({
        run_id: params.run_id,
        content_type: params.content_type,
        content: params.content,
        artifact_suffix: params.artifact_suffix,
      });
    },
  },
  {
    name: HEP_RUN_BUILD_WRITING_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build reusable writing evidence artifacts for a run (LaTeX evidence catalog + embeddings + enrichment; optional PDF evidence; Evidence-first, local-only).',
    zodSchema: HepRunBuildWritingEvidenceToolSchema,
    handler: async (params, ctx) => {
      const { buildRunWritingEvidence } = await import('../../core/writing/evidence.js');
      const raw = ctx.rawArgs ?? {};
      const maxEvidenceItemsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_evidence_items');
      return buildRunWritingEvidence({
        run_id: params.run_id,
        latex_sources: params.latex_sources,
        pdf_source: params.pdf_source,
        continue_on_error: params.continue_on_error,
        latex_types: params.latex_types,
        pdf_types: params.pdf_types,
        max_evidence_items: params.max_evidence_items,
        embedding_dim: params.embedding_dim,
        latex_catalog_artifact_name: params.latex_catalog_artifact_name,
        latex_embeddings_artifact_name: params.latex_embeddings_artifact_name,
        latex_enrichment_artifact_name: params.latex_enrichment_artifact_name,
        pdf_embeddings_artifact_name: params.pdf_embeddings_artifact_name,
        pdf_enrichment_artifact_name: params.pdf_enrichment_artifact_name,
        budget_hints: { max_evidence_items_provided: maxEvidenceItemsProvided },
      });
    },
  },
  {
    name: HEP_RUN_BUILD_MEASUREMENTS,
    tier: 'core',
    exposure: 'standard',
    description:
      'Extract HEP-style numeric measurements from a run LaTeX evidence catalog and write artifacts + diagnostics (Evidence-first, local-only).',
    zodSchema: HepRunBuildMeasurementsToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const maxResultsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_results');
      return buildRunMeasurements({
        run_id: params.run_id,
        latex_catalog_artifact_name: params.latex_catalog_artifact_name,
        include_types: params.include_types,
        target_quantities: params.target_quantities,
        max_results: params.max_results,
        measurements_artifact_name: params.measurements_artifact_name,
        meta_artifact_name: params.meta_artifact_name,
        budget_hints: { max_results_provided: maxResultsProvided },
      });
    },
  },
  {
    name: HEP_PROJECT_COMPARE_MEASUREMENTS,
    tier: 'core',
    exposure: 'standard',
    description:
      'Compare extracted measurements across multiple runs and flag pairwise tensions (flagging-only; not a world-average combiner; Evidence-first, local-only).',
    zodSchema: HepProjectCompareMeasurementsToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const maxFlagsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_flags');
      return compareProjectMeasurements({
        run_id: params.run_id,
        input_runs: params.input_runs,
        min_tension_sigma: params.min_tension_sigma,
        max_flags: params.max_flags,
        include_not_comparable: params.include_not_comparable,
        output_artifact_name: params.output_artifact_name,
        budget_hints: { max_flags_provided: maxFlagsProvided },
      });
    },
  },
  {
    name: HEP_RENDER_LATEX,
    tier: 'core',
    exposure: 'standard',
    description:
      'Render structured SectionDraft/ReportDraft into LaTeX and write artifacts (Evidence-first, local-only)',
    zodSchema: HepRenderLatexToolSchema,
    handler: async params => renderLatexForRun({
      run_id: params.run_id,
      draft: params.draft,
      cite_mapping: params.cite_mapping,
      latex_artifact_name: params.latex_artifact_name,
      section_output_artifact_name: params.section_output_artifact_name,
    }),
  },
  {
    name: HEP_EXPORT_PROJECT,
    tier: 'core',
    exposure: 'standard',
    description:
      'Export run outputs as research assets: master.bib, report.tex, report.md, research_pack.zip, and NotebookLM-friendly artifacts (Evidence-first, local-only)',
    zodSchema: HepExportProjectToolSchema,
    handler: async params => exportProjectForRun({
      run_id: params.run_id,
      rendered_latex_artifact_name: params.rendered_latex_artifact_name,
      rendered_latex_verification_artifact_name: params.rendered_latex_verification_artifact_name,
      bibliography_raw_artifact_name: params.bibliography_raw_artifact_name,
      master_bib_artifact_name: params.master_bib_artifact_name,
      report_tex_artifact_name: params.report_tex_artifact_name,
      report_md_artifact_name: params.report_md_artifact_name,
      research_pack_zip_artifact_name: params.research_pack_zip_artifact_name,
      notebooklm_pack_prefix: params.notebooklm_pack_prefix,
      max_chars_per_notebooklm_file: params.max_chars_per_notebooklm_file,
      include_evidence_digests: params.include_evidence_digests,
      include_pdg_artifacts: params.include_pdg_artifacts,
      include_paper_bundle: params.include_paper_bundle,
      paper_bundle_zip_artifact_name: params.paper_bundle_zip_artifact_name,
      paper_bundle_manifest_artifact_name: params.paper_bundle_manifest_artifact_name,
    }),
  },
  {
    name: HEP_EXPORT_PAPER_SCAFFOLD,
    tier: 'core',
    exposure: 'standard',
    description:
      'Export a publication-ready paper/ scaffold for a run (RevTeX4-2): materialize LaTeX + bib split into paper/ and write a portable paper_scaffold.zip (Evidence-first; local-only).',
    zodSchema: HepExportPaperScaffoldToolSchema,
    handler: async params => exportPaperScaffoldForRun({
      run_id: params.run_id,
      output_dir_name: params.output_dir_name,
      overwrite: params.overwrite,
      integrated_latex_artifact_name: params.integrated_latex_artifact_name,
      writing_master_bib_artifact_name: params.writing_master_bib_artifact_name,
      bibliography_raw_artifact_name: params.bibliography_raw_artifact_name,
      zip_artifact_name: params.zip_artifact_name,
      paper_manifest_artifact_name: params.paper_manifest_artifact_name,
    }),
  },
  {
    name: HEP_IMPORT_PAPER_BUNDLE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Import a finalized paper/ (post research-writer) back into a run as portable artifacts (paper_bundle.zip + paper_bundle_manifest.json + optional paper_final.pdf) (Evidence-first; local-only).',
    zodSchema: HepImportPaperBundleToolSchema,
    handler: async params => importPaperBundleForRun({
      run_id: params.run_id,
      paper_dir_name: params.paper_dir_name,
      zip_artifact_name: params.zip_artifact_name,
      bundle_manifest_artifact_name: params.bundle_manifest_artifact_name,
      pdf_artifact_name: params.pdf_artifact_name,
      overwrite: params.overwrite,
      dereference_symlinks: params.dereference_symlinks,
      allow_external_symlink_targets: params.allow_external_symlink_targets,
    }),
  },
  {
    name: HEP_RUN_BUILD_PDF_EVIDENCE,
    tier: 'core',
    exposure: 'standard',
    description:
      'Build PDF evidence for a run (text pages + optional visual region snippets) and write artifacts (Evidence-first, local-only)',
    zodSchema: HepRunBuildPdfEvidenceToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const maxPagesProvided = Object.prototype.hasOwnProperty.call(raw, 'max_pages');
      const maxRegionsTotalProvided = Object.prototype.hasOwnProperty.call(raw, 'max_regions_total');
      return buildRunPdfEvidence({
        run_id: params.run_id,
        pdf_path: params.pdf_path,
        pdf_artifact_name: params.pdf_artifact_name,
        zotero_attachment_key: params.zotero_attachment_key,
        fulltext_artifact_name: params.fulltext_artifact_name,
        docling_json_path: params.docling_json_path,
        docling_json_artifact_name: params.docling_json_artifact_name,
        mode: params.mode,
        max_pages: params.max_pages,
        render_dpi: params.render_dpi,
        output_prefix: params.output_prefix,
        max_regions_total: params.max_regions_total,
        budget_hints: {
          max_pages_provided: maxPagesProvided,
          max_regions_total_provided: maxRegionsTotalProvided,
        },
      });
    },
  },
  {
    name: HEP_INSPIRE_SEARCH_EXPORT,
    tier: 'core',
    exposure: 'standard',
    description:
      'Export an INSPIRE search (safe pagination) to run artifacts (jsonl/json). Network (INSPIRE) + Evidence-first output (URIs + summary).',
    zodSchema: HepInspireSearchExportToolSchema,
    handler: async (params, ctx) => {
      const raw = ctx.rawArgs ?? {};
      const sizeProvided = Object.prototype.hasOwnProperty.call(raw, 'size');
      const maxResultsProvided = Object.prototype.hasOwnProperty.call(raw, 'max_results');
      return hepInspireSearchExport({
        run_id: params.run_id,
        query: params.query,
        sort: params.sort,
        size: params.size,
        max_results: params.max_results,
        output_format: params.output_format,
        artifact_name: params.artifact_name,
        meta_artifact_name: params.meta_artifact_name,
        budget_hints: {
          size_provided: sizeProvided,
          max_results_provided: maxResultsProvided,
        },
      });
    },
  },
  {
    name: HEP_INSPIRE_RESOLVE_IDENTIFIERS,
    tier: 'core',
    exposure: 'standard',
    description:
      'Batch resolve identifiers (recid/arXiv/DOI) to INSPIRE recids and write mapping artifacts (network; Evidence-first URIs + summary).',
    zodSchema: HepInspireResolveIdentifiersToolSchema,
    handler: async params =>
      hepInspireResolveIdentifiers({
        run_id: params.run_id,
        identifiers: params.identifiers,
        artifact_name: params.artifact_name,
        meta_artifact_name: params.meta_artifact_name,
      }),
  },
];
