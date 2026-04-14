import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GeneV1, MutationProposalV1 } from '@autoresearch/shared';
import { createMemoryGraph } from '@autoresearch/shared';
import type { ComputationResultV1 } from '@autoresearch/shared';
import { writeJsonAtomic } from './io.js';

interface GeneLibraryV1 {
  schema_version: 1;
  genes: GeneV1[];
}

function geneLibraryPath(projectRoot: string): string {
  return path.join(projectRoot, '.autoresearch', 'gene_library_v1.json');
}

function defaultGeneLibrary(): GeneLibraryV1 {
  return {
    schema_version: 1,
    genes: [],
  };
}

function readGeneLibrary(projectRoot: string): GeneLibraryV1 {
  const filePath = geneLibraryPath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return defaultGeneLibrary();
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as GeneLibraryV1;
}

function writeGeneLibrary(projectRoot: string, payload: GeneLibraryV1): void {
  writeJsonAtomic(geneLibraryPath(projectRoot), payload);
}

function proposalArtifactPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, 'artifacts', 'runs', runId, 'mutation_proposal_repair_v1.json');
}

function repairStrategy(): MutationProposalV1['strategy'] {
  return {
    rigor: 0.85,
    creativity: 0.2,
    verbosity: 0.4,
    risk_tolerance: 0.15,
    obedience: 0.95,
  };
}

function buildGene(params: {
  signalKey: string;
  signals: string[];
  summary: string;
}): GeneV1 {
  const createdAt = new Date().toISOString();
  const [firstSignal, ...restSignals] = params.signals;
  if (!firstSignal) {
    throw new Error('repair gene requires at least one signal');
  }
  return {
    gene_id: `gene_auto_${params.signalKey}`,
    name: `repair-${params.signalKey}`,
    description: `Local repair gene derived from repeated failed compute signals: ${params.summary}`,
    signals_match: [firstSignal, ...restSignals],
    target_scope: 'run-local/computation/**',
    mutation_type: 'repair',
    validation: [
      'npx vitest run packages/orchestrator/tests/compute-loop-feedback.test.ts packages/orchestrator/tests/compute-loop-execution.test.ts',
    ],
    origin: 'auto_gene',
    max_files: 3,
    confidence: 0.6,
    total_uses: 0,
    success_count: 0,
    last_used: null,
    created_at: createdAt,
    node_id: null,
  };
}

export async function maybeGenerateRepairProposal(params: {
  projectRoot: string;
  runId: string;
  signalKey: string;
  signals: string[];
  computationResult: ComputationResultV1;
}): Promise<{
  proposalPath: string;
  proposal: MutationProposalV1;
} | null> {
  if (params.computationResult.execution_status !== 'failed') {
    return null;
  }

  const graph = createMemoryGraph({ dbPath: path.join(params.projectRoot, '.autoresearch', 'memory-graph.sqlite') });
  const recent = await graph.getRecentEvents(200);
  const occurrenceCount = recent.filter(
    (event) => event.event_type === 'signal'
      && event.run_id
      && (event.payload as Record<string, unknown>).signal_key === params.signalKey,
  ).length;

  if (occurrenceCount < 2) {
    return null;
  }

  const geneLibrary = readGeneLibrary(params.projectRoot);
  let gene = geneLibrary.genes.find((candidate) => candidate.signals_match.join('|') === params.signals.join('|'));
  if (!gene) {
    gene = buildGene({
      signalKey: params.signalKey,
      signals: params.signals,
      summary: params.computationResult.failure_reason ?? params.computationResult.summary,
    });
    const nodeId = await graph.addNode({
      node_type: 'gene',
      track: 'b',
      payload: {
        gene_id: gene.gene_id,
        name: gene.name,
        description: gene.description,
        signals_match: gene.signals_match,
        target_scope: gene.target_scope,
        mutation_type: gene.mutation_type,
        validation: gene.validation,
        origin: gene.origin,
      },
      decay_ts: null,
      weight: 1,
    });
    gene = { ...gene, node_id: nodeId };
    writeGeneLibrary(params.projectRoot, {
      schema_version: 1,
      genes: [...geneLibrary.genes, gene],
    });
  }

  const proposal: MutationProposalV1 = {
    proposal_id: `mp_${randomUUID()}`,
    mutation_type: 'repair',
    gene_id: gene.gene_id,
    signals: params.signals,
    strategy: repairStrategy(),
    gate_level: 'A1',
    status: 'proposed',
    blast_severity: 'within_limit',
    run_id: params.runId,
    created_at: new Date().toISOString(),
  };

  const artifactPath = proposalArtifactPath(params.projectRoot, params.runId);
  writeJsonAtomic(artifactPath, proposal);
  return {
    proposalPath: artifactPath,
    proposal,
  };
}
