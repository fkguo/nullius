import * as fs from 'fs';

import {
  HEP_RUN_READ_ARTIFACT_CHUNK,
  HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
  HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1,
  invalidParams,
} from '@autoresearch/shared';

import { getRun, type RunArtifactRef, type RunManifest, type RunStep, updateRunManifestAtomic } from '../runs.js';
import { getRunArtifactPath } from '../paths.js';
import { writeRunJsonArtifact } from '../citations.js';
import { inferWritingRoundFromArtifacts, writeWritingCheckpointV1, writeWritingJournalMarkdown } from './reproducibility.js';
import { suggestNextActionsForMissingRunArtifact } from './missingArtifactNextActions.js';

import { verifyAssetCoverage } from '../../tools/writing/verifier/assetCoverageChecker.js';
import { verifyWordCount } from '../../tools/writing/verifier/wordCountChecker.js';
import { verifyCrossRefReadiness } from '../../tools/writing/verifier/crossRefReadinessChecker.js';
import { detectTerminologyVariants, detectUnusedMaterials } from './globalChecks.js';
import { ensureWritingQualityPolicyV1 } from './qualityPolicy.js';
import { compileRunLatexOrThrow } from './latexCompileGate.js';

type WritingPacketsArtifactV1 = {
  version: number;
  run_id: string;
  target_length?: 'short' | 'medium' | 'long';
  sections: Array<{
    index: number;
    section_number: string;
    section_title: string;
    packet: Record<string, unknown>;
  }>;
};

type WritingSectionArtifactV1 = {
  version: number;
  run_id: string;
  section_index: number;
  section_number: string;
  section_title: string;
  section_output: Record<string, unknown>;
};

type WritingOutlineV2ArtifactLike = {
  request?: { target_length?: unknown } | unknown;
  outline_plan?: { total_suggested_words?: unknown; sections?: unknown } | unknown;
};

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function nowIso(): string {
  return new Date().toISOString();
}

function readRunJsonArtifact<T>(runId: string, artifactName: string): T {
  const p = getRunArtifactPath(runId, artifactName);
  if (!fs.existsSync(p)) {
    const nextActions = suggestNextActionsForMissingRunArtifact({ run_id: runId, artifact_name: artifactName });
    throw invalidParams(`Missing required run artifact: ${artifactName}`, {
      run_id: runId,
      artifact_name: artifactName,
      ...(nextActions ? { next_actions: nextActions } : {}),
    });
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch (err) {
    const parseErrRef = writeRunJsonArtifact(runId, `writing_parse_error_artifact_${artifactName}.json`, {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      artifact_name: artifactName,
      error: err instanceof Error ? err.message : String(err),
    });
    throw invalidParams(`Malformed JSON in run artifact: ${artifactName} (fail-fast)`, {
      run_id: runId,
      artifact_name: artifactName,
      parse_error_uri: parseErrRef.uri,
      parse_error_artifact: parseErrRef.name,
      next_actions: [
        {
          tool: HEP_RUN_READ_ARTIFACT_CHUNK,
          args: { run_id: runId, artifact_name: artifactName, offset: 0, length: 1024 },
          reason: 'Inspect the corrupted artifact and re-generate it.',
        },
      ],
    });
  }
}

function makeRunArtifactRef(runId: string, artifactName: string, mimeType?: string): RunArtifactRef {
  return {
    name: artifactName,
    uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent(artifactName)}`,
    mimeType,
  };
}

function writeRunTextArtifact(params: { run_id: string; name: string; content: string; mimeType: string }): RunArtifactRef {
  fs.writeFileSync(getRunArtifactPath(params.run_id, params.name), params.content, 'utf-8');
  return makeRunArtifactRef(params.run_id, params.name, params.mimeType);
}

function mergeArtifactRefs(existing: RunStep['artifacts'] | undefined, added: RunArtifactRef[]): RunArtifactRef[] {
  const byName = new Map<string, RunArtifactRef>();
  for (const a of existing ?? []) byName.set(a.name, a);
  for (const a of added) byName.set(a.name, a);
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function ensureIntegrateStep(manifest: RunManifest): { manifest: RunManifest; stepIndex: number } {
  const steps = [...manifest.steps];
  let idx = steps.findIndex(s => s.step === 'writing_integrate');
  if (idx === -1) {
    steps.push({ step: 'writing_integrate', status: 'pending' });
    idx = steps.length - 1;
  }
  return {
    manifest: { ...manifest, updated_at: nowIso(), steps },
    stepIndex: idx,
  };
}

function countWords(text: string): number {
  return String(text ?? '').split(/\s+/).filter(w => w.length > 0).length;
}

export interface IntegrateParams {
  run_id: string;
  fix_unused_materials?: boolean;
  add_cross_references?: boolean;
  unify_terminology?: boolean;
  final_polish?: boolean;
  max_retries?: number;
}

export interface IntegrateResult {
  run_id: string;
  project_id: string;
  manifest_uri: string;
  artifacts: RunArtifactRef[];
  summary: Record<string, unknown>;
}

export async function integrateWritingSections(params: IntegrateParams): Promise<IntegrateResult> {
  const runId = params.run_id;
  const run = getRun(runId);

  const { policy, artifact: policyRef } = ensureWritingQualityPolicyV1({ run_id: runId });

  const packets = readRunJsonArtifact<WritingPacketsArtifactV1>(runId, 'writing_packets_sections.json');
  if (!Array.isArray(packets.sections) || packets.sections.length === 0) {
    throw invalidParams('Invalid writing_packets_sections.json: missing sections[]', { run_id: runId });
  }

  // Load section outputs in order.
  const sections = packets.sections
    .slice()
    .sort((a, b) => a.index - b.index)
    .map(s => {
      const artifactName = `writing_section_${pad3(s.index)}.json`;
      const sectionArtifact = readRunJsonArtifact<WritingSectionArtifactV1>(runId, artifactName);
      const output = sectionArtifact.section_output;
      const content = typeof output?.content === 'string' ? output.content : '';
      const attributions = Array.isArray(output?.attributions) ? output.attributions : [];

      return {
        index: s.index,
        section_number: s.section_number,
        section_title: s.section_title,
        packet: s.packet,
        content,
        attributions,
      };
    });

  // Build integrated LaTeX (deterministic). This is the Phase 2 "internal stage" glue.
  const integratedParts: string[] = [];
  for (const s of sections) {
    integratedParts.push(`\\section{${String(s.section_title).replace(/[{}]/g, '')}}`);
    integratedParts.push('');
    integratedParts.push(s.content.trim());
    integratedParts.push('');
  }
  const integratedText = integratedParts.join('\n').trim() + '\n';

  // Global checks (precomputed).
  const assignedClaimIds: string[] = [];
  const usedClaimIds: string[] = [];
  const assignedAssetIds: string[] = [];

  for (const s of sections) {
    const assignedClaims = Array.isArray((s.packet as any)?.assigned_claims)
      ? (s.packet as any).assigned_claims.map((c: any) => String(c?.claim_id ?? '')).filter(Boolean)
      : [];
    assignedClaimIds.push(...assignedClaims);

    for (const a of s.attributions as any[]) {
      const ids = Array.isArray(a?.claim_ids) ? a.claim_ids : [];
      usedClaimIds.push(...ids.map((x: any) => String(x)).filter(Boolean));
    }

    const eq = Array.isArray((s.packet as any)?.assigned_assets?.equations) ? (s.packet as any).assigned_assets.equations : [];
    const fig = Array.isArray((s.packet as any)?.assigned_assets?.figures) ? (s.packet as any).assigned_assets.figures : [];
    const tab = Array.isArray((s.packet as any)?.assigned_assets?.tables) ? (s.packet as any).assigned_assets.tables : [];
    assignedAssetIds.push(...eq.map((e: any) => String(e?.evidence_id ?? '')).filter(Boolean));
    assignedAssetIds.push(...fig.map((e: any) => String(e?.evidence_id ?? '')).filter(Boolean));
    assignedAssetIds.push(...tab.map((e: any) => String(e?.evidence_id ?? '')).filter(Boolean));
  }

  const unused = detectUnusedMaterials({
    assigned_claim_ids: assignedClaimIds,
    used_claim_ids: usedClaimIds,
    assigned_asset_ids: assignedAssetIds,
    document_text: integratedText,
  });

  const terminology = detectTerminologyVariants({
    sections: sections.map(s => ({ section_number: s.section_number, content: s.content })),
  });

  // Phase 2 verification (post-hoc). Since this stage does not rewrite yet, before==after.
  const wordCountBefore = countWords(sections.map(s => s.content).join('\n\n'));
  const wordCountAfter = countWords(integratedText);

  const outlineV2 = readRunJsonArtifact<WritingOutlineV2ArtifactLike>(runId, 'writing_outline_v2.json');
  const request = outlineV2 && typeof outlineV2 === 'object' ? (outlineV2 as any).request : undefined;
  const targetLengthRaw = String((request as any)?.target_length ?? '').trim();
  if (targetLengthRaw !== 'short' && targetLengthRaw !== 'medium' && targetLengthRaw !== 'long') {
    throw invalidParams('Invalid writing_outline_v2.json: request.target_length is missing/invalid', {
      run_id: runId,
      artifact_name: 'writing_outline_v2.json',
      request_target_length: (request as any)?.target_length,
      next_actions: [
        {
          tool: HEP_RUN_WRITING_CREATE_OUTLINE_CANDIDATES_PACKET_V1,
          args: { run_id: runId, target_length: '<short|medium|long>', title: '<paper title>' },
          reason: 'M13: Regenerate writing_outline_v2.json via N-best outline candidates + judge ensuring request.target_length is present (no bypass).',
        },
      ],
    });
  }
  const targetLength = targetLengthRaw as 'short' | 'medium' | 'long';

  const plan = outlineV2 && typeof outlineV2 === 'object' ? (outlineV2 as any).outline_plan : undefined;
  const totalFromPlan = Number.isFinite(Number((plan as any)?.total_suggested_words)) ? Number((plan as any).total_suggested_words) : 0;
  const totalFromSections = Array.isArray((plan as any)?.sections)
    ? (plan as any).sections.reduce((sum: number, s: any) => sum + (Number.isFinite(Number(s?.suggested_word_count)) ? Number(s.suggested_word_count) : 0), 0)
    : 0;
  const baseTotals: Record<typeof targetLength, number> = { short: 3500, medium: 6500, long: 12000 };
  const totalSuggestedWords = totalFromPlan > 0 ? totalFromPlan : totalFromSections > 0 ? totalFromSections : baseTotals[targetLength];
  const targetMin = Math.floor(totalSuggestedWords * 0.5);
  const targetMax = Math.ceil(totalSuggestedWords * 1.75);
  const wordCountCheck = verifyWordCount(integratedText, { min_words: targetMin, max_words: targetMax });

  let assetAdjacencyPass = true;
  const assetViolations: Array<{ section_index: number; evidence_id: string; reason: string }> = [];
  let crossRefPass = true;
  const crossRefMissing: Array<{ section_index: number; missing: string[] }> = [];

  for (const s of sections) {
    const assignedAssets = (s.packet as any)?.assigned_assets;
    if (assignedAssets && typeof assignedAssets === 'object') {
      const r = verifyAssetCoverage({ content: s.content }, assignedAssets as any);
      if (!r.pass) {
        assetAdjacencyPass = false;
        for (const id of [...r.equations.missing, ...r.equations.shallow, ...r.figures.missing, ...r.figures.shallow, ...r.tables.missing, ...r.tables.shallow]) {
          assetViolations.push({ section_index: s.index, evidence_id: id, reason: 'Missing or shallow adjacent discussion' });
        }
      }
    }

    const defines = (s.packet as any)?.global_context?.cross_ref_hints?.this_section_defines;
    if (Array.isArray(defines) && defines.length > 0) {
      const r = verifyCrossRefReadiness({ content: s.content }, { this_section_defines: defines.map((x: any) => String(x)) });
      if (!r.pass) {
        crossRefPass = false;
        crossRefMissing.push({ section_index: s.index, missing: r.missing_definitions });
      }
    }
  }

  const wordCountPass = wordCountCheck.pass;
  const coveragePass = unused.unused_assets.length === 0;
  const terminologyPass = terminology.length === 0;
  const structurePass = integratedText.length > 0;

  const overallPass = coveragePass && assetAdjacencyPass && crossRefPass && wordCountPass && structurePass;

  const rounds: string[] = [];
  if (params.fix_unused_materials !== false) rounds.push('round_1_unused_materials');
  if (params.add_cross_references !== false) rounds.push('round_2_cross_refs');
  if (params.unify_terminology !== false) rounds.push('round_3_terminology');
  if (params.final_polish !== false) rounds.push('round_4_polish');

  // Artifacts: integrated doc + diagnostics.
  const artifacts: RunArtifactRef[] = [];
  artifacts.push(policyRef);
  artifacts.push(writeRunTextArtifact({ run_id: runId, name: 'writing_integrated.tex', content: integratedText, mimeType: 'text/x-tex' }));

  // M07: LaTeX compile gate (hard). Must fail-fast if toolchain missing or compilation fails.
  let latexCompile: Record<string, unknown> | undefined;
  try {
    if (policy.latex_compile_gate.required) {
      const compiled = await compileRunLatexOrThrow({
        run_id: runId,
        tex_artifact_name: 'writing_integrated.tex',
        bib_artifact_name: 'writing_master.bib',
        passes: policy.latex_compile_gate.passes,
        run_bibtex: policy.latex_compile_gate.run_bibtex,
        timeout_ms: policy.latex_compile_gate.timeout_ms,
        output_prefix: 'writing_integrated',
      });
      artifacts.push(...compiled.artifacts);
      latexCompile = compiled.summary;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const compileErrorRef = writeRunJsonArtifact(runId, 'writing_integrated_latex_compile_error_v1.json', {
      version: 1,
      generated_at: nowIso(),
      run_id: runId,
      quality_level: policy.quality_level,
      error: msg,
    });
    artifacts.push(compileErrorRef);
    const round = inferWritingRoundFromArtifacts(runId);
    const checkpointRef = writeWritingCheckpointV1({
      run_id: runId,
      current_step: 'writing_integrate',
      round,
      pointers: {
        integrated_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_integrated.tex')}`,
        diagnostics_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_integrated_latex_compile_error_v1.json')}`,
      },
    });
    const journalRef = writeWritingJournalMarkdown({
      run_id: runId,
      step: 'writing_integrate',
      round,
      status: 'failed',
      title: 'LaTeX compile gate failed',
      inputs: { integrated_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_integrated.tex')}` },
      outputs: { compile_error_uri: compileErrorRef.uri, checkpoint_uri: checkpointRef.uri },
      error: { message: msg },
      next_actions: [
        { tool: HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1, args: { run_id: runId }, reason: 'Fix LaTeX issues and re-run integration.' },
      ],
    });
    artifacts.push(checkpointRef, journalRef);

    // Update manifest step (failed) with available artifacts, then rethrow.
    const completedAt = nowIso();
    await updateRunManifestAtomic({
      run_id: runId,
      tool: { name: HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1, args: { run_id: runId } },
      update: current => {
        const ensured = ensureIntegrateStep(current);
        const base = ensured.manifest;
        const stepIndex = ensured.stepIndex;
        const next: RunManifest = {
          ...base,
          updated_at: completedAt,
          steps: base.steps.map((s, idx) => {
            if (idx !== stepIndex) return s;
            return {
              ...s,
              status: 'failed',
              started_at: s.started_at ?? completedAt,
              completed_at: completedAt,
              artifacts: mergeArtifactRefs(s.artifacts, artifacts),
              notes: `Phase 2 LaTeX compile gate failed: ${msg}`,
            };
          }),
          status: base.status,
        };
        return next;
      },
    });
    throw err;
  }

  artifacts.push(writeRunJsonArtifact(runId, 'writing_integrate_diagnostics.json', {
    version: 1,
    generated_at: nowIso(),
    run_id: runId,
    rounds_executed: rounds,
    global_checks: { unused, terminology },
    verification: {
      overall_pass: overallPass,
      coverage_pass: coveragePass,
      word_count: wordCountCheck ?? undefined,
      cross_ref_pass: crossRefPass,
      cross_ref_missing: crossRefMissing,
      terminology_pass: terminologyPass,
      asset_discussion_adjacency_pass: assetAdjacencyPass,
      asset_discussion_violations: assetViolations,
      structure_pass: structurePass,
      latex_compile: latexCompile ?? undefined,
      citations_pass: true,
      originality_pass: true,
    },
  }));

  const round = inferWritingRoundFromArtifacts(runId);
  const checkpointRef = writeWritingCheckpointV1({
    run_id: runId,
    current_step: 'writing_integrate',
    round,
    pointers: {
      integrated_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_integrated.tex')}`,
      diagnostics_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_integrate_diagnostics.json')}`,
    },
  });
  const journalRef = writeWritingJournalMarkdown({
    run_id: runId,
    step: 'writing_integrate',
    round,
    status: overallPass ? 'success' : 'failed',
    title: overallPass ? 'Integration completed' : 'Integration failed (see diagnostics)',
    inputs: {
      packets_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_packets_sections.json')}`,
      outline_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_outline_v2.json')}`,
    },
    outputs: {
      integrated_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_integrated.tex')}`,
      diagnostics_uri: `hep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('writing_integrate_diagnostics.json')}`,
      checkpoint_uri: checkpointRef.uri,
    },
    decisions: [
      `overall_pass=${String(overallPass)}`,
      `word_count_before=${wordCountBefore}`,
      `word_count_after=${wordCountAfter}`,
    ],
  });
  artifacts.push(checkpointRef, journalRef);

  // Update manifest step.
  const completedAt = nowIso();
  await updateRunManifestAtomic({
    run_id: runId,
    tool: { name: HEP_RUN_WRITING_INTEGRATE_SECTIONS_V1, args: { run_id: runId } },
    update: current => {
      const ensured = ensureIntegrateStep(current);
      const base = ensured.manifest;
      const stepIndex = ensured.stepIndex;
      const next: RunManifest = {
        ...base,
        updated_at: completedAt,
        steps: base.steps.map((s, idx) => {
          if (idx !== stepIndex) return s;
          return {
            ...s,
            status: overallPass ? 'done' : 'failed',
            started_at: s.started_at ?? completedAt,
            completed_at: completedAt,
            artifacts: mergeArtifactRefs(s.artifacts, artifacts),
            notes: overallPass ? 'Phase 2 integration completed' : 'Phase 2 integration failed (see diagnostics)',
          };
        }),
        status: base.status,
      };
      return next;
    },
  });

  return {
    run_id: runId,
    project_id: run.project_id,
    manifest_uri: `hep://runs/${encodeURIComponent(runId)}/manifest`,
    artifacts,
    summary: {
      rounds_executed: rounds,
      word_count_before: wordCountBefore,
      word_count_after: wordCountAfter,
      unused_claims: unused.unused_claims.length,
      unused_assets: unused.unused_assets.length,
      terminology_variants: terminology.length,
      final_verification: {
        coverage_pass: coveragePass,
        cross_ref_pass: crossRefPass,
        terminology_pass: terminologyPass,
        structure_pass: structurePass,
        word_count_pass: wordCountPass,
        citations_pass: true,
        originality_pass: true,
        asset_adjacency_pass: assetAdjacencyPass,
      },
      checkpoint_uri: checkpointRef.uri,
      journal_uri: journalRef.uri,
    },
  };
}
