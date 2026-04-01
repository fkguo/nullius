import * as fs from 'fs';

import { getRunArtifactPath } from '../../src/core/paths.js';
import { previewHasMarker } from './sem06eEvalSupport.js';

export type Sem06fScenario = 'visual_enabled' | 'visual_unavailable' | 'visual_ambiguous';
export type Sem06fInput = {
  query: string;
  scenario?: Sem06fScenario;
  disable_multimodal?: boolean;
};
export type Sem06fExpected = {
  top_unit: 'page' | 'chunk' | 'table' | 'figure' | 'equation' | 'citation_context';
  top_status: 'localized' | 'fallback_available' | 'abstained';
  availability: 'localized' | 'fallback_available' | 'unavailable' | 'abstained';
  marker?: string;
  multimodal_status: 'applied' | 'unsupported' | 'disabled' | 'abstained' | 'skipped';
};
export type Sem06fActual = {
  topUnit: string | null;
  topStatus: string | null;
  topPreviewMatches: boolean;
  availability: string | null;
  multimodalStatus: string | null;
  visualCandidatesScanned: number;
  supplementedCandidates: number;
  boostedHits: number;
};

type SparseVector = { dim: number; indices: number[]; values: number[] };

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_:+-]+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return normalize(text).split(' ').map(token => token.trim()).filter(Boolean);
}

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function buildSparseVector(text: string, dim: number): SparseVector {
  const counts = new Map<number, number>();
  for (const token of tokenize(text)) {
    const hash = fnv1a32(token);
    const bucket = hash % dim;
    const sign = (hash & 1) === 0 ? 1 : -1;
    counts.set(bucket, (counts.get(bucket) ?? 0) + sign);
  }
  const entries = Array.from(counts.entries()).sort((lhs, rhs) => lhs[0] - rhs[0]);
  const indices: number[] = [];
  const values: number[] = [];
  let norm2 = 0;
  for (const [, value] of entries) norm2 += value * value;
  const norm = norm2 > 0 ? Math.sqrt(norm2) : 1;
  for (const [index, value] of entries) {
    if (value === 0) continue;
    indices.push(index);
    values.push(value / norm);
  }
  return { dim, indices, values };
}

function writeJsonlArtifact(path: string, rows: unknown[]): void {
  fs.writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf-8');
}

function artifactUri(runId: string, artifactName: string): string {
  return `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`;
}

function readRunPaperId(runId: string): string {
  const catalogPath = getRunArtifactPath(runId, 'latex_evidence_catalog.jsonl');
  const firstLine = fs.readFileSync(catalogPath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) throw new Error(`latex evidence catalog is empty for run ${runId}`);
  const firstItem = JSON.parse(firstLine) as { paper_id?: unknown };
  if (typeof firstItem.paper_id !== 'string' || firstItem.paper_id.trim().length === 0) {
    throw new Error(`latex evidence catalog is missing paper_id for run ${runId}`);
  }
  return firstItem.paper_id;
}

export function buildSem06fLatex(): string {
  return `\\documentclass{article}
\\begin{document}
TEXT_GOLD The threshold enhancement is explained in the main prose discussion.

The page-native visual evidence lives on the PDF surface rather than in explicit LaTeX figure, table, or equation environments.
\\end{document}
`;
}

export function augmentRunWithSem06fPdfSurface(runId: string, scenario: Sem06fScenario): void {
  const metaPath = getRunArtifactPath(runId, 'writing_evidence_meta_v1.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
  const paperId = readRunPaperId(runId);
  const outputPrefix = `pdf_sem06f_${scenario}`;
  const catalogArtifactName = `${outputPrefix}_evidence_catalog.jsonl`;
  const embeddingsArtifactName = `${outputPrefix}_evidence_embeddings.jsonl`;
  const enrichmentArtifactName = `${outputPrefix}_evidence_enrichment.jsonl`;
  const catalogPath = getRunArtifactPath(runId, catalogArtifactName);
  const embeddingsPath = getRunArtifactPath(runId, embeddingsArtifactName);
  const enrichmentPath = getRunArtifactPath(runId, enrichmentArtifactName);
  const dim = 256;
  const visualPageMeta = scenario === 'visual_enabled' || scenario === 'visual_ambiguous'
    ? { page_render_uri: artifactUri(runId, `${outputPrefix}_page_0002.png`) }
    : {};

  const pdfItems: Array<Record<string, unknown>> = [
    { version: 1, evidence_id: 'pdf_page_1', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_page', locator: { kind: 'pdf', page: 1 }, text: 'VISPAGE_GOLD_001 TEXT_GOLD threshold enhancement prose discussion.', normalized_text: normalize('VISPAGE_GOLD_001 TEXT_GOLD threshold enhancement prose discussion.'), meta: scenario === 'visual_enabled' || scenario === 'visual_ambiguous' ? { page_render_uri: artifactUri(runId, `${outputPrefix}_page_0001.png`) } : {} },
    { version: 1, evidence_id: 'pdf_page_2', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_page', locator: { kind: 'pdf', page: 2 }, text: 'VISPAGE_GOLD_002 phase diagram evidence and mass spectrum overview.', normalized_text: normalize('VISPAGE_GOLD_002 phase diagram evidence and mass spectrum overview.'), meta: visualPageMeta },
  ];

  if (scenario === 'visual_enabled' || scenario === 'visual_unavailable') {
    const regionMeta = scenario === 'visual_enabled';
    pdfItems.push(
      { version: 1, evidence_id: 'pdf_region_figure', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_region', locator: { kind: 'pdf', page: 2, bbox: { x0: 0.1, y0: 0.1, x1: 0.8, y1: 0.4 } }, text: 'VISFIG_GOLD mass spectrum anomaly on the phase diagram.', normalized_text: normalize('VISFIG_GOLD mass spectrum anomaly on the phase diagram.'), meta: { label: 'picture', ...(regionMeta ? { region_uri: artifactUri(runId, `${outputPrefix}_region_figure.png`) } : {}) } },
      { version: 1, evidence_id: 'pdf_region_table', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_region', locator: { kind: 'pdf', page: 3, bbox: { x0: 0.2, y0: 0.2, x1: 0.9, y1: 0.45 } }, text: 'VISTABLE_GOLD branching fractions for the benchmark channel.', normalized_text: normalize('VISTABLE_GOLD branching fractions for the benchmark channel.'), meta: { label: 'table', ...(regionMeta ? { region_uri: artifactUri(runId, `${outputPrefix}_region_table.png`) } : {}) } },
      { version: 1, evidence_id: 'pdf_region_equation', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_region', locator: { kind: 'pdf', page: 4, bbox: { x0: 0.15, y0: 0.15, x1: 0.85, y1: 0.35 } }, text: 'VISEQ_GOLD beta function running coupling relation.', normalized_text: normalize('VISEQ_GOLD beta function running coupling relation.'), meta: { label: 'formula', ...(regionMeta ? { region_uri: artifactUri(runId, `${outputPrefix}_region_equation.png`) } : {}) } },
    );
  }

  if (scenario === 'visual_ambiguous') {
    pdfItems.push(
      { version: 1, evidence_id: 'pdf_region_figure_a', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_region', locator: { kind: 'pdf', page: 5, bbox: { x0: 0.1, y0: 0.1, x1: 0.45, y1: 0.4 } }, text: 'AMBIG_A resonance anomaly plot in the benchmark channel.', normalized_text: normalize('AMBIG_A resonance anomaly plot in the benchmark channel.'), meta: { label: 'picture', region_uri: artifactUri(runId, `${outputPrefix}_region_figure_a.png`) } },
      { version: 1, evidence_id: 'pdf_region_figure_b', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_region', locator: { kind: 'pdf', page: 5, bbox: { x0: 0.5, y0: 0.1, x1: 0.9, y1: 0.4 } }, text: 'AMBIG_B resonance anomaly panel in the benchmark channel.', normalized_text: normalize('AMBIG_B resonance anomaly panel in the benchmark channel.'), meta: { label: 'picture', region_uri: artifactUri(runId, `${outputPrefix}_region_figure_b.png`) } },
    );
  }

  writeJsonlArtifact(catalogPath, pdfItems);
  writeJsonlArtifact(embeddingsPath, pdfItems.map(item => ({ evidence_id: item.evidence_id, model: 'fixture_sparse', vector: buildSparseVector(String(item.text ?? ''), dim), type: item.type, run_id: runId })));
  writeJsonlArtifact(enrichmentPath, pdfItems.map(item => ({ evidence_id: item.evidence_id, importance_score: item.type === 'pdf_page' ? 0.45 : 0.8, type: item.type, run_id: runId })));
  meta.pdf = {
    paper_id: paperId,
    output_prefix: outputPrefix,
    catalog_uri: artifactUri(runId, catalogArtifactName),
    embeddings_artifact_name: embeddingsArtifactName,
    enrichment_artifact_name: enrichmentArtifactName,
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
}

export function extractSem06fActual(artifact: Record<string, unknown>, expected: Sem06fExpected): Sem06fActual {
  const result = (artifact.result as Record<string, unknown> | undefined) ?? {};
  const hits = Array.isArray(result.hits) ? result.hits as Array<Record<string, unknown>> : [];
  const top = hits[0] ?? null;
  const localization = top && typeof top.localization === 'object' && top.localization !== null
    ? top.localization as Record<string, unknown>
    : null;
  const topPreview = typeof top?.text_preview === 'string' ? top.text_preview : '';
  const multimodal = typeof artifact.multimodal === 'object' && artifact.multimodal !== null
    ? artifact.multimodal as Record<string, unknown>
    : null;
  const telemetry = multimodal && typeof multimodal.telemetry === 'object' && multimodal.telemetry !== null
    ? multimodal.telemetry as Record<string, unknown>
    : null;
  const artifactLocalization = typeof artifact.localization === 'object' && artifact.localization !== null
    ? artifact.localization as Record<string, unknown>
    : null;
  return {
    topUnit: localization && typeof localization.unit === 'string' ? localization.unit : null,
    topStatus: localization && typeof localization.status === 'string' ? localization.status : null,
    topPreviewMatches: expected.marker ? previewHasMarker(topPreview, expected.marker) : true,
    availability: artifactLocalization && typeof artifactLocalization.availability === 'string' ? artifactLocalization.availability : null,
    multimodalStatus: multimodal && typeof multimodal.status === 'string' ? multimodal.status : null,
    visualCandidatesScanned: typeof telemetry?.visual_candidates_scanned === 'number' ? telemetry.visual_candidates_scanned : 0,
    supplementedCandidates: typeof telemetry?.supplemented_candidates === 'number' ? telemetry.supplemented_candidates : 0,
    boostedHits: typeof telemetry?.boosted_hits === 'number' ? telemetry.boosted_hits : 0,
  };
}
