import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ArtifactRefV1,
  VerificationCoverageV1,
  VerificationSubjectV1,
  VerificationSubjectVerdictV1,
  WritingReviewBridgeV1,
} from '@autoresearch/shared';
import {
  deriveReproducibilityProjection,
  evaluateRdiGate,
} from '@autoresearch/rep-sdk/validation';
import type {
  ArtifactRef,
  ResearchOutcome,
  VerificationCoverage,
  VerificationSubject,
  VerificationSubjectVerdict,
} from '@autoresearch/rep-sdk';

export type ReviewFollowupGateDecision = 'pass' | 'block' | 'advisory_only' | 'unavailable';

export type ReviewFollowupGateResult = {
  decision: ReviewFollowupGateDecision;
  reason?: string;
};

function runArtifactPathFromUri(runDir: string, uri: string): string {
  const prefix = 'rep://runs/';
  if (!uri.startsWith(prefix)) {
    throw new Error(`review follow-up gate only supports rep://runs artifact refs, got: ${uri}`);
  }
  const artifactMarker = '/artifact/';
  const artifactIndex = uri.indexOf(artifactMarker);
  if (artifactIndex < 0) {
    throw new Error(`review follow-up gate requires artifact refs, got: ${uri}`);
  }
  const relativePath = decodeURIComponent(uri.slice(artifactIndex + artifactMarker.length));
  const filePath = path.resolve(runDir, relativePath);
  if (filePath !== runDir && !filePath.startsWith(`${runDir}${path.sep}`)) {
    throw new Error(`review follow-up gate artifact ref escapes run dir: ${uri}`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`review follow-up gate artifact ref not found: ${uri}`);
  }
  return filePath;
}

function loadJsonArtifact<T>(runDir: string, ref: ArtifactRefV1): T {
  return JSON.parse(fs.readFileSync(runArtifactPathFromUri(runDir, ref.uri), 'utf-8')) as T;
}

function toRepArtifactRef(ref: ArtifactRefV1): ArtifactRef {
  return {
    uri: ref.uri,
    kind: ref.kind,
    sha256: ref.sha256,
    size_bytes: ref.size_bytes,
    produced_by: ref.produced_by,
    created_at: ref.created_at,
  };
}

function buildGateOutcome(runId: string): ResearchOutcome {
  return {
    schema_version: 1,
    outcome_id: `outcome:${runId}:review_followup_gate`,
    lineage_id: `lineage:${runId}:review_followup_gate`,
    version: 1,
    strategy_ref: `strategy:${runId}:review_followup_gate`,
    status: 'pending',
    metrics: {},
    artifacts: [],
    produced_by: {
      agent_id: '@autoresearch/orchestrator',
      run_id: runId,
    },
    created_at: new Date().toISOString(),
  };
}

export function evaluateReviewFollowupGate(params: {
  bridge: WritingReviewBridgeV1;
  runDir: string;
}): ReviewFollowupGateResult {
  if (params.bridge.bridge_kind !== 'review') {
    return { decision: 'unavailable' };
  }

  const refs = params.bridge.verification_refs;
  if (!refs?.subject_refs?.length || !refs.subject_verdict_refs?.length || !refs.coverage_refs?.length) {
    return { decision: 'unavailable' };
  }

  try {
    const subjectRef = refs.subject_refs[0]!;
    const verdictRef = refs.subject_verdict_refs[0]!;
    const coverageRef = refs.coverage_refs[0]!;
    const subject = loadJsonArtifact<VerificationSubjectV1>(params.runDir, subjectRef);
    const verdict = loadJsonArtifact<VerificationSubjectVerdictV1>(params.runDir, verdictRef);
    const coverage = loadJsonArtifact<VerificationCoverageV1>(params.runDir, coverageRef);

    const projection = deriveReproducibilityProjection({
      subject: subject as unknown as VerificationSubject,
      subjectRef: toRepArtifactRef(subjectRef),
      verdict: verdict as unknown as VerificationSubjectVerdict,
      verdictRef: toRepArtifactRef(verdictRef),
      coverage: coverage as unknown as VerificationCoverage,
      coverageRef: toRepArtifactRef(coverageRef),
    });
    const gate = evaluateRdiGate({
      outcome: buildGateOutcome(params.bridge.run_id),
      reproducibilityProjection: projection,
    });

    if (projection.integrity.gate_decision === 'block') {
      return {
        decision: 'block',
        reason: projection.integrity.summary,
      };
    }
    if (projection.integrity.gate_decision === 'hold' || !gate.passed) {
      return {
        decision: 'advisory_only',
        reason: projection.integrity.summary,
      };
    }
    return { decision: 'pass' };
  } catch (error) {
    return {
      decision: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
