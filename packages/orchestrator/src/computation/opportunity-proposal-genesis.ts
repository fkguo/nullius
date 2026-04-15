import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ComputationManifestV1, ComputationResultV1, MutationProposalV1 } from '@autoresearch/shared';
import { writeJsonAtomic } from './io.js';
import { mutationProposalFingerprint, shouldSuppressProposal } from '../proposal-decisions.js';

function packageSignature(manifest: ComputationManifestV1): { workflowSignature: string; packageNames: string[]; toolNames: string[]; ecosystems: string[] } | null {
  const packageNames = [
    ...(manifest.dependencies?.mathematica_packages ?? []).map(pkg => `mathematica:${pkg}`),
    ...(manifest.dependencies?.julia_packages ?? []).map(pkg => `julia:${pkg}`),
    ...(manifest.dependencies?.python_packages ?? []).map(pkg => `python:${pkg}`),
  ].sort();
  if (packageNames.length === 0) {
    return null;
  }
  const toolNames = [...new Set(manifest.steps.map(step => step.tool))].sort();
  const ecosystems = [...new Set(packageNames.map(name => name.split(':')[0] ?? name))].sort();
  return {
    workflowSignature: [...toolNames, ...packageNames].join('|'),
    packageNames,
    toolNames,
    ecosystems,
  };
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function successfulRunStats(params: {
  projectRoot: string;
  workflowSignature: string;
}): {
  exactMatches: string[];
  allSuccessfulRuns: string[];
  ecosystems: Set<string>;
} {
  const exactMatches: string[] = [];
  const allSuccessfulRuns: string[] = [];
  const ecosystems = new Set<string>();
  for (const entry of fs.readdirSync(params.projectRoot).sort()) {
    const runDir = path.join(params.projectRoot, entry);
    if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) continue;
    if (entry === '.autoresearch' || entry === 'artifacts' || entry.startsWith('.')) continue;
    const result = readJsonIfExists<ComputationResultV1>(path.join(runDir, 'artifacts', 'computation_result_v1.json'));
    if (!result || result.execution_status !== 'completed') continue;
    const manifest = readJsonIfExists<ComputationManifestV1>(path.join(runDir, 'computation', 'manifest.json'));
    if (!manifest) continue;
    const signature = packageSignature(manifest);
    if (!signature) continue;
    allSuccessfulRuns.push(entry);
    signature.ecosystems.forEach(ecosystem => ecosystems.add(ecosystem));
    if (signature.workflowSignature === params.workflowSignature) {
      exactMatches.push(entry);
    }
  }
  return { exactMatches, allSuccessfulRuns, ecosystems };
}

function mutationArtifactPath(projectRoot: string, runId: string, kind: 'optimize' | 'innovate'): string {
  return path.join(projectRoot, 'artifacts', 'runs', runId, `mutation_proposal_${kind}_v1.json`);
}

function strategyFor(kind: 'optimize' | 'innovate'): MutationProposalV1['strategy'] {
  return kind === 'optimize'
    ? { rigor: 0.8, creativity: 0.35, verbosity: 0.45, risk_tolerance: 0.25, obedience: 0.9 }
    : { rigor: 0.7, creativity: 0.6, verbosity: 0.45, risk_tolerance: 0.35, obedience: 0.85 };
}

function buildProposal(params: {
  kind: 'optimize' | 'innovate';
  runId: string;
  signalSummary: string[];
}): MutationProposalV1 {
  const hash = createHash('sha1').update(params.signalSummary.join('|')).digest('hex').slice(0, 8);
  return {
    proposal_id: `mp_${randomUUID()}`,
    mutation_type: params.kind,
    gene_id: `gene_${params.kind}_${hash}`,
    signals: params.signalSummary,
    strategy: strategyFor(params.kind),
    gate_level: params.kind === 'optimize' ? 'A0' : 'A2',
    status: 'proposed',
    run_id: params.runId,
    created_at: new Date().toISOString(),
  };
}

export function maybeGenerateOpportunityProposals(params: {
  projectRoot: string;
  runId: string;
  manifest: ComputationManifestV1;
  computationResult: ComputationResultV1;
}): {
  optimize: { proposalPath: string; proposal: MutationProposalV1 } | { suppressed: true; proposalFingerprint: string; decision: string } | null;
  innovate: { proposalPath: string; proposal: MutationProposalV1 } | { suppressed: true; proposalFingerprint: string; decision: string } | null;
} {
  if (params.computationResult.execution_status !== 'completed') {
    return { optimize: null, innovate: null };
  }
  const signature = packageSignature(params.manifest);
  if (!signature) {
    return { optimize: null, innovate: null };
  }
  const stats = successfulRunStats({
    projectRoot: params.projectRoot,
    workflowSignature: signature.workflowSignature,
  });

  let optimize: { proposalPath: string; proposal: MutationProposalV1 } | { suppressed: true; proposalFingerprint: string; decision: string } | null = null;
  if (stats.exactMatches.length >= 3) {
    const proposal = buildProposal({
      kind: 'optimize',
      runId: params.runId,
      signalSummary: [
        'opportunity:optimize',
        `workflow_signature:${signature.workflowSignature}`,
        `successful_runs:${stats.exactMatches.length}`,
        ...signature.packageNames,
      ],
    });
    const proposalFingerprint = mutationProposalFingerprint(proposal);
    const suppression = shouldSuppressProposal({
      projectRoot: params.projectRoot,
      proposalKind: 'optimize',
      proposalFingerprint,
    });
    if (suppression.suppressed) {
      optimize = {
        suppressed: true,
        proposalFingerprint,
        decision: suppression.decision?.decision ?? 'dismissed',
      };
    } else {
      const proposalPath = mutationArtifactPath(params.projectRoot, params.runId, 'optimize');
      writeJsonAtomic(proposalPath, proposal);
      optimize = { proposalPath, proposal };
    }
  }

  let innovate: { proposalPath: string; proposal: MutationProposalV1 } | { suppressed: true; proposalFingerprint: string; decision: string } | null = null;
  if (stats.exactMatches.length >= 4 && signature.ecosystems.length >= 2) {
    const proposal = buildProposal({
      kind: 'innovate',
      runId: params.runId,
      signalSummary: [
        'opportunity:innovate',
        `workflow_signature:${signature.workflowSignature}`,
        `successful_runs:${stats.exactMatches.length}`,
        `ecosystems:${signature.ecosystems.join(',')}`,
        ...signature.toolNames,
      ],
    });
    const proposalFingerprint = mutationProposalFingerprint(proposal);
    const suppression = shouldSuppressProposal({
      projectRoot: params.projectRoot,
      proposalKind: 'innovate',
      proposalFingerprint,
    });
    if (suppression.suppressed) {
      innovate = {
        suppressed: true,
        proposalFingerprint,
        decision: suppression.decision?.decision ?? 'dismissed',
      };
    } else {
      const proposalPath = mutationArtifactPath(params.projectRoot, params.runId, 'innovate');
      writeJsonAtomic(proposalPath, proposal);
      innovate = { proposalPath, proposal };
    }
  }

  return { optimize, innovate };
}
