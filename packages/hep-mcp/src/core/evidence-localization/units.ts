import type { EvidenceLocalizationUnit, EvidenceType } from '@autoresearch/shared';

import { mapEvidenceTypeToLocalizationUnit } from './scoring.js';

function readStringMeta(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function hasPdfVisualArtifact(item: { type: EvidenceType; meta?: Record<string, unknown> }): boolean {
  if (item.type === 'pdf_page') return Boolean(readStringMeta(item.meta, 'page_render_uri'));
  if (item.type === 'pdf_region') return Boolean(readStringMeta(item.meta, 'region_uri'));
  return false;
}

export function pdfRegionLabelToUnit(label: unknown): EvidenceLocalizationUnit | undefined {
  if (typeof label !== 'string') return undefined;
  const normalized = label.trim().toLowerCase();
  if (normalized === 'picture') return 'figure';
  if (normalized === 'table') return 'table';
  if (normalized === 'formula') return 'equation';
  return undefined;
}

export function inferCatalogItemLocalizationUnit(item: {
  type: EvidenceType;
  meta?: Record<string, unknown>;
}): EvidenceLocalizationUnit {
  if (item.type === 'pdf_region' && hasPdfVisualArtifact(item)) {
    const labeledUnit = pdfRegionLabelToUnit(item.meta?.label);
    if (labeledUnit) return labeledUnit;
  }
  return mapEvidenceTypeToLocalizationUnit(item.type);
}
