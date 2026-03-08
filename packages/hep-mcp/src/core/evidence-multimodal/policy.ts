import type {
  EvidenceLocalizationUnit,
  EvidenceMultimodalArtifact,
  EvidenceMultimodalReasonCode,
  EvidenceType,
} from '@autoresearch/shared';

import type { LocalizationCatalogItem } from '../evidence-localization/localize.js';
import { inferRequestedLocalizationUnit } from '../evidence-localization/localize.js';
import { hasPdfVisualArtifact, inferCatalogItemLocalizationUnit } from '../evidence-localization/units.js';

const MULTIMODAL_UNITS = new Set<EvidenceLocalizationUnit>(['page', 'figure', 'table', 'equation']);

function parseEnabledFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === '') return true;
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return true;
}

function baseArtifact(params: {
  status: EvidenceMultimodalArtifact['status'];
  requestedUnit?: EvidenceLocalizationUnit;
  reasonCodes: EvidenceMultimodalReasonCode[];
}): EvidenceMultimodalArtifact {
  return {
    version: 1,
    status: params.status,
    requested_unit: params.requestedUnit,
    reason_codes: params.reasonCodes,
    promoted_evidence_ids: [],
    telemetry: {
      fusion_passes: 0,
      visual_candidates_scanned: 0,
      supplemented_candidates: 0,
      boosted_hits: 0,
      latency_ms: 0,
    },
  };
}

export function buildSemanticFallbackMultimodalArtifact(requestedUnit: EvidenceLocalizationUnit | undefined): EvidenceMultimodalArtifact {
  return baseArtifact({
    status: 'skipped',
    requestedUnit,
    reasonCodes: ['semantic_fallback_active'],
  });
}

export function buildMultimodalPolicy(params: {
  query: string;
  types?: EvidenceType[];
  allItems: LocalizationCatalogItem[];
}): {
  requestedUnit?: EvidenceLocalizationUnit;
  visualItems: LocalizationCatalogItem[];
  artifact: EvidenceMultimodalArtifact;
  canApply: boolean;
} {
  const requestedUnit = inferRequestedLocalizationUnit({ query: params.query, types: params.types });
  if (!parseEnabledFlag(process.env.HEP_ENABLE_MULTIMODAL_RETRIEVAL)) {
    return {
      requestedUnit,
      visualItems: [],
      artifact: baseArtifact({ status: 'disabled', requestedUnit, reasonCodes: ['policy_disabled'] }),
      canApply: false,
    };
  }

  if (!requestedUnit || !MULTIMODAL_UNITS.has(requestedUnit)) {
    return {
      requestedUnit,
      visualItems: [],
      artifact: baseArtifact({ status: 'skipped', requestedUnit, reasonCodes: ['query_not_page_native'] }),
      canApply: false,
    };
  }

  const visualItems = params.allItems.filter(item => item.locator.kind === 'pdf' && hasPdfVisualArtifact(item));
  if (visualItems.length === 0) {
    return {
      requestedUnit,
      visualItems: [],
      artifact: baseArtifact({ status: 'unsupported', requestedUnit, reasonCodes: ['pdf_visual_surface_missing'] }),
      canApply: false,
    };
  }

  const matchingVisualUnit = visualItems.some(item => inferCatalogItemLocalizationUnit(item) === requestedUnit);
  if (!matchingVisualUnit && requestedUnit !== 'page') {
    return {
      requestedUnit,
      visualItems,
      artifact: baseArtifact({ status: 'unsupported', requestedUnit, reasonCodes: ['requested_visual_label_missing'] }),
      canApply: false,
    };
  }

  return {
    requestedUnit,
    visualItems,
    artifact: baseArtifact({ status: 'applied', requestedUnit, reasonCodes: [] }),
    canApply: true,
  };
}
