import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ComputationManifestV1, ComputationResultV1, SkillProposalV2 } from '@autoresearch/shared';
import { writeJsonAtomic } from './io.js';

function proposalArtifactPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, 'artifacts', 'runs', runId, 'skill_proposal_v2.json');
}

function packageSignature(manifest: ComputationManifestV1): { workflowSignature: string; packageNames: string[]; toolNames: string[] } | null {
  const packageNames = [
    ...(manifest.dependencies?.mathematica_packages ?? []).map(pkg => `mathematica:${pkg}`),
    ...(manifest.dependencies?.julia_packages ?? []).map(pkg => `julia:${pkg}`),
    ...(manifest.dependencies?.python_packages ?? []).map(pkg => `python:${pkg}`),
  ].sort();
  if (packageNames.length === 0) {
    return null;
  }
  const toolNames = [...new Set(manifest.steps.map(step => step.tool))].sort();
  return {
    workflowSignature: [...toolNames, ...packageNames].join('|'),
    packageNames,
    toolNames,
  };
}

function artifactUriToPseudoTraceId(uri: string): string {
  const hash = createHash('sha1').update(uri).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function matchingSuccessfulRuns(params: {
  projectRoot: string;
  currentRunId: string;
  workflowSignature: string;
}): Array<{
  runId: string;
  computationResult: ComputationResultV1;
  manifestPath: string;
}> {
  const runsRoot = params.projectRoot;
  if (!fs.existsSync(runsRoot)) {
    return [];
  }
  const matches: Array<{ runId: string; computationResult: ComputationResultV1; manifestPath: string }> = [];
  for (const runId of fs.readdirSync(runsRoot).sort()) {
    const runDir = path.join(params.projectRoot, runId);
    if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) continue;
    if (runId === '.autoresearch' || runId === 'artifacts' || runId.startsWith('.')) continue;
    const resultPath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    const result = readJsonIfExists<ComputationResultV1>(resultPath);
    if (!result || result.execution_status !== 'completed') continue;
    const manifestPath = path.join(runDir, 'computation', 'manifest.json');
    const manifest = readJsonIfExists<ComputationManifestV1>(manifestPath);
    if (!manifest) continue;
    const signature = packageSignature(manifest);
    if (!signature || signature.workflowSignature !== params.workflowSignature) continue;
    matches.push({ runId, computationResult: result, manifestPath });
  }
  return matches;
}

export function maybeGenerateSkillProposal(params: {
  projectRoot: string;
  runId: string;
  manifest: ComputationManifestV1;
  computationResult: ComputationResultV1;
}): {
  proposalPath: string;
  proposal: SkillProposalV2;
} | null {
  if (params.computationResult.execution_status !== 'completed') {
    return null;
  }
  const signature = packageSignature(params.manifest);
  if (!signature) {
    return null;
  }
  const matches = matchingSuccessfulRuns({
    projectRoot: params.projectRoot,
    currentRunId: params.runId,
    workflowSignature: signature.workflowSignature,
  });
  const distinctRuns = [...new Set(matches.map(match => match.runId))];
  if (distinctRuns.length < 2) {
    return null;
  }

  const evidence = matches.flatMap((match, index) => {
    const computationUri = `rep://runs/${match.runId}/artifact/artifacts/computation_result_v1.json`;
    const computationTrace = {
      trace_id: artifactUriToPseudoTraceId(`${computationUri}#result`),
      run_id: match.runId,
      file_path: path.relative(params.projectRoot, path.join(params.projectRoot, match.runId, 'artifacts', 'computation_result_v1.json')).split(path.sep).join('/'),
      timestamp: match.computationResult.finished_at,
      artifact_uri: computationUri,
    };
    if (index === matches.length - 1) {
      const manifestUri = `rep://runs/${match.runId}/artifact/computation/manifest.json`;
      return [
        computationTrace,
        {
          trace_id: artifactUriToPseudoTraceId(`${manifestUri}#manifest`),
          run_id: match.runId,
          file_path: path.relative(params.projectRoot, match.manifestPath).split(path.sep).join('/'),
          timestamp: match.computationResult.finished_at,
          artifact_uri: manifestUri,
        },
      ];
    }
    return [computationTrace];
  });

  if (evidence.length < 3) {
    return null;
  }

  const proposal: SkillProposalV2 = {
    proposal_id: `sp_${randomUUID()}`,
    proposal_type: 'new_skill',
    origin: 'agent_trace',
    name: `package-playbook-${createHash('sha1').update(signature.workflowSignature).digest('hex').slice(0, 8)}`,
    description: `Repeated successful科研过程 using ${signature.packageNames.join(', ')} should be suggested as a reusable package playbook.`,
    trigger: {
      description: `Repeated successful package-usage workflow detected for ${signature.packageNames.join(', ')}`,
      pattern_kind: 'package_usage_pattern',
      tool_names: signature.toolNames,
      package_names: signature.packageNames,
      workflow_signature: signature.workflowSignature,
      signal_pattern: signature.packageNames.join('|'),
    },
    action: {
      type: 'package_playbook',
      rule: `Suggest the established package playbook before manually recomposing the same ${signature.packageNames.join(', ')} workflow.`,
    },
    evidence_traces: evidence as SkillProposalV2['evidence_traces'],
    generalization_confidence: Math.min(0.5 + (distinctRuns.length - 2) * 0.1, 0.8),
    gate_level: 'A1',
    status: 'pending_review',
    created_at: new Date().toISOString(),
  };

  const artifactPath = proposalArtifactPath(params.projectRoot, params.runId);
  writeJsonAtomic(artifactPath, proposal);
  return {
    proposalPath: artifactPath,
    proposal,
  };
}
