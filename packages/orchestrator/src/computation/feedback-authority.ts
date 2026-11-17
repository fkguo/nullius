import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseScopedArtifactUri, type ComputationResultV1 } from '@nullius/shared';
import { sha256File } from './io.js';
import { assertNoSymlinkComponents, resolveUnderRoot } from './path-safety.js';
import { readFeedbackDeclaration, RESEARCH_FEEDBACK_FILENAME } from './result-signal.js';

/** Historical result bytes stay readable; only a current, bound declaration may execute. */
export function feedbackAuthorityError(result: ComputationResultV1, runDir: string): string | null {
  const lowering = result.feedback_lowering;
  if (result.execution_status !== 'completed' || lowering?.basis !== 'producer_declaration' || !lowering.declaration_ref) {
    return 'Follow-up requires an explicit producer declaration; historical inferred feedback is read-only.';
  }
  const ref = lowering.declaration_ref;
  const parsed = parseScopedArtifactUri(ref.uri, { scheme: 'rep', scope: 'runs' });
  const produced = result.produced_artifact_refs.filter(item => item.uri === ref.uri);
  const declarations = result.produced_artifact_refs.filter(item => {
    const source = parseScopedArtifactUri(item.uri, { scheme: 'rep', scope: 'runs' });
    return source && path.basename(source.artifactName) === RESEARCH_FEEDBACK_FILENAME;
  });
  if (!parsed || parsed.scopeId !== result.run_id || path.basename(parsed.artifactName) !== RESEARCH_FEEDBACK_FILENAME
    || declarations.length !== 1 || produced.length !== 1 || produced[0]!.sha256 !== ref.sha256) {
    return 'Feedback declaration must bind a produced research_feedback.json artifact from this run.';
  }
  const filePath = resolveUnderRoot(runDir, parsed.artifactName);
  if (!filePath) return 'Feedback declaration path leaves the run directory.';
  try {
    assertNoSymlinkComponents(runDir, filePath, 'feedback declaration');
    if (!fs.statSync(filePath).isFile()) return 'Feedback declaration must be a regular file.';
    if (sha256File(filePath) !== ref.sha256) return 'Feedback declaration bytes changed; fresh explicit feedback is required.';
    const declaration = readFeedbackDeclaration({ executionStatus: result.execution_status, producedOutputs: [filePath] });
    if (!declaration || declaration.signal !== lowering.signal) return 'Feedback declaration is invalid or differs from the requested follow-up.';
  } catch {
    return 'Feedback declaration is unavailable; historical result bytes remain readable.';
  }
  return null;
}
