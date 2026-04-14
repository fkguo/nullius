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
  evaluateVerificationKernelGateV1,
} from '@autoresearch/shared';

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
    const subject = loadJsonArtifact<VerificationSubjectV1>(params.runDir, subjectRef);
    const verdict = loadJsonArtifact<VerificationSubjectVerdictV1>(params.runDir, refs.subject_verdict_refs[0]!);
    const coverage = loadJsonArtifact<VerificationCoverageV1>(params.runDir, refs.coverage_refs[0]!);
    const gate = evaluateVerificationKernelGateV1({
      expected_run_id: params.bridge.run_id,
      subject,
      verdict,
      coverage,
    });

    if (gate.decision === 'block') {
      return {
        decision: 'block',
        reason: gate.summary,
      };
    }
    if (gate.decision === 'hold') {
      return {
        decision: 'advisory_only',
        reason: gate.summary,
      };
    }
    if (gate.decision === 'pass') {
      return { decision: 'pass' };
    }
    return {
      decision: 'unavailable',
      reason: gate.summary,
    };
  } catch (error) {
    return {
      decision: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
