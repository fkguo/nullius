import * as fs from 'fs';

import type { EvidenceType } from '@autoresearch/shared';

import { getRunArtifactPath } from '../../src/core/paths.js';

export type Sem06eInput = { query: string };
export type Sem06eExpected = {
  top_unit: 'page' | 'chunk' | 'table' | 'figure' | 'equation' | 'citation_context';
  expected_status: 'localized' | 'fallback_available' | 'unavailable' | 'abstained';
  marker: string;
};
export type Sem06eActual = {
  topUnit: string | null;
  topStatus: string | null;
  topPreviewHasMarker: boolean;
  availability: string | null;
  structureScans: number;
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

function normalizeMarkerText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function previewHasMarker(text: string, marker: string): boolean {
  return normalizeMarkerText(text).includes(normalizeMarkerText(marker));
}

export function buildSem06eLatex(): string {
  return `\\documentclass{article}
\\begin{document}
\\section{Overview}
DECOY paragraph about threshold effects without the gold marker.

CHUNK_GOLD The benchmark signal is driven by threshold enhancement in the main channel.

As discussed by \\citep{Smith2024}, CITATION_GOLD the threshold enhancement is driven by channel coupling.

\\begin{equation}
\\label{eq:beta}
EQUATION_GOLD \\beta(g) = -b_0 g^3 + O(g^5)
\\end{equation}

\\begin{figure}
\\caption{FIGURE_GOLD Mass spectrum with the threshold cusp.}
\\label{fig:cusp}
\\end{figure}

\\begin{table}
\\caption{TABLE_GOLD Branching fractions for the benchmark channel.}
\\label{tab:branching}
\\begin{tabular}{cc}
mode & value \\\\
A & 0.12 \\\\
\\end{tabular}
\\end{table}

\\begin{thebibliography}{1}
\\bibitem{Smith2024} A. Smith, Threshold dynamics.
\\end{thebibliography}
\\end{document}
`;
}

export function augmentRunWithPdfSurface(runId: string): void {
  const metaPath = getRunArtifactPath(runId, 'writing_evidence_meta_v1.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
  const paperId = readRunPaperId(runId);
  const outputPrefix = 'pdf_sem06e';
  const catalogArtifactName = `${outputPrefix}_evidence_catalog.jsonl`;
  const embeddingsArtifactName = `${outputPrefix}_evidence_embeddings.jsonl`;
  const enrichmentArtifactName = `${outputPrefix}_evidence_enrichment.jsonl`;
  const catalogPath = getRunArtifactPath(runId, catalogArtifactName);
  const embeddingsPath = getRunArtifactPath(runId, embeddingsArtifactName);
  const enrichmentPath = getRunArtifactPath(runId, enrichmentArtifactName);
  const dim = 256;
  const pdfItems = [
    { version: 1, evidence_id: 'pdf_page_1', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_page', locator: { kind: 'pdf', page: 1 }, text: 'PAGE_GOLD_001 FIGURE_GOLD Mass spectrum with the threshold cusp.', normalized_text: normalize('PAGE_GOLD_001 FIGURE_GOLD Mass spectrum with the threshold cusp.') },
    { version: 1, evidence_id: 'pdf_page_2', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_page', locator: { kind: 'pdf', page: 2 }, text: 'PAGE_GOLD_002 TABLE_GOLD Branching fractions for the benchmark channel. CHUNK_GOLD The benchmark signal is driven by threshold enhancement in the main channel.', normalized_text: normalize('PAGE_GOLD_002 TABLE_GOLD Branching fractions for the benchmark channel. CHUNK_GOLD The benchmark signal is driven by threshold enhancement in the main channel.') },
    { version: 1, evidence_id: 'pdf_region_table', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_region', locator: { kind: 'pdf', page: 2, bbox: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.3 } }, text: 'TABLE_GOLD Branching fractions for the benchmark channel.', normalized_text: normalize('TABLE_GOLD Branching fractions for the benchmark channel.') },
    { version: 1, evidence_id: 'pdf_region_figure', run_id: runId, project_id: meta.project_id, paper_id: paperId, type: 'pdf_region', locator: { kind: 'pdf', page: 1, bbox: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.45 } }, text: 'FIGURE_GOLD Mass spectrum with the threshold cusp.', normalized_text: normalize('FIGURE_GOLD Mass spectrum with the threshold cusp.') },
  ] as const;
  writeJsonlArtifact(catalogPath, pdfItems);
  writeJsonlArtifact(embeddingsPath, pdfItems.map(item => ({ evidence_id: item.evidence_id, model: 'fixture_sparse', vector: buildSparseVector(item.text, dim), type: item.type, run_id: runId })));
  writeJsonlArtifact(enrichmentPath, pdfItems.map(item => ({ evidence_id: item.evidence_id, importance_score: item.type === 'pdf_page' ? 0.45 : 0.8, type: item.type, run_id: runId })));
  meta.pdf = {
    paper_id: paperId,
    output_prefix: outputPrefix,
    catalog_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(catalogArtifactName)}`,
    embeddings_artifact_name: embeddingsArtifactName,
    enrichment_artifact_name: enrichmentArtifactName,
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
}

export function extractActual(artifact: Record<string, unknown>, expected: Sem06eExpected): Sem06eActual {
  const result = (artifact.result as Record<string, unknown> | undefined) ?? {};
  const hits = Array.isArray(result.hits) ? result.hits as Array<Record<string, unknown>> : [];
  const top = hits[0] ?? null;
  const localization = top && typeof top.localization === 'object' && top.localization !== null
    ? top.localization as Record<string, unknown>
    : null;
  const topPreview = typeof top?.text_preview === 'string' ? top.text_preview : '';
  const topUnit = localization && typeof localization.unit === 'string' ? localization.unit : null;
  const topStatus = localization && typeof localization.status === 'string' ? localization.status : null;
  const artifactLocalization = typeof artifact.localization === 'object' && artifact.localization !== null
    ? artifact.localization as Record<string, unknown>
    : null;
  const telemetry = artifactLocalization && typeof artifactLocalization.telemetry === 'object' && artifactLocalization.telemetry !== null
    ? artifactLocalization.telemetry as Record<string, unknown>
    : null;
  return {
    topUnit,
    topStatus,
    topPreviewHasMarker: previewHasMarker(topPreview, expected.marker),
    availability: artifactLocalization && typeof artifactLocalization.availability === 'string' ? artifactLocalization.availability : null,
    structureScans: typeof telemetry?.structure_scans === 'number' ? telemetry.structure_scans : 0,
  };
}
