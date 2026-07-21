import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'vitest';
import { RpcError } from '../../src/service/errors.js';
import { IdeaEngineRpcService } from '../../src/service/rpc-service.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = resolve(packageRoot, 'bin/idea-rpc.mjs');
const crashDriver = resolve(packageRoot, 'tests/helpers/revise-card-crash-driver.mjs');
const distEntry = resolve(packageRoot, 'dist/index.js');

export function fresh(tempDirs: string[], prefix: string): {
  rootDir: string;
  service: IdeaEngineRpcService;
} {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(rootDir);
  return {
    rootDir,
    service: new IdeaEngineRpcService({
      rootDir,
      now: () => '2026-07-21T07:30:00.000Z',
    }),
  };
}

export function initCampaign(service: IdeaEngineRpcService, key = 'init-key'): { campaignId: string; nodeId: string } {
  const result = service.handle('campaign.init', {
    budget: {
      max_cost_usd: 100,
      max_nodes: 20,
      max_steps: 20,
      max_tokens: 100_000,
      max_wall_clock_s: 10_000,
    },
    charter: {
      approval_gate_ref: 'gate://a0.1',
      campaign_name: 'card revision test',
      domain: 'test-domain',
      scope: 'optimistic card revision fixture',
    },
    idempotency_key: key,
    seed_pack: {
      seeds: [
        {
          content: 'A source-grounded scientific proposition for revision testing.',
          seed_type: 'text',
          source_uris: ['https://example.org/source'],
        },
      ],
    },
  });
  const campaignId = String(result.campaign_id);
  const nodeId = Object.keys(service.read.store.loadNodes(campaignId))[0]!;
  return { campaignId, nodeId };
}

export function currentNode(service: IdeaEngineRpcService, campaignId: string, nodeId: string): Record<string, unknown> {
  return service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
}

export function replacementCard(node: Record<string, unknown>, thesis: string): Record<string, unknown> {
  const card = structuredClone(node.idea_card) as Record<string, unknown>;
  card.thesis_statement = thesis;
  return card;
}

export function reviseParams(
  campaignId: string,
  nodeId: string,
  node: Record<string, unknown>,
  key: string,
  thesis = 'A revised scientific proposition with Unicode Ω and  two preserved spaces.',
): Record<string, unknown> {
  return {
    campaign_id: campaignId,
    node_id: nodeId,
    expected_revision: node.revision,
    replacement_idea_card: replacementCard(node, thesis),
    reason: 'new evidence changes the scientific proposition',
    idempotency_key: key,
  };
}

export function expectRpcError(fn: () => unknown, code: number, reason: string): RpcError {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    expect(error.code).toBe(code);
    expect(error.data.reason).toBe(reason);
    return error;
  }
  throw new Error(`expected RpcError ${code}/${reason}`);
}

export function enterReview(service: IdeaEngineRpcService, campaignId: string, nodeId: string, key: string): void {
  service.handle('node.set_lifecycle', {
    campaign_id: campaignId,
    node_id: nodeId,
    lifecycle_state: 'admission_review',
    idempotency_key: key,
  });
}

export function setPosterior(service: IdeaEngineRpcService, campaignId: string, nodeId: string, key: string, status: 'current' | 'provisional' = 'current'): void {
  service.handle('node.set_posterior', {
    campaign_id: campaignId,
    node_id: nodeId,
    posterior: {
      value: 0.71,
      evidence_count: 6,
      status,
      gaia_package_ref: 'project://gaia/idea-package',
    },
    literature_coverage: {
      status: 'saturated',
      survey_ref: 'project://literature/survey.json',
      close_prior_matrix_ref: 'project://literature/close-prior.json',
    },
    idempotency_key: key,
  });
}

export function reductionReport(): Record<string, unknown> {
  return {
    abstract_problem: 'generic inverse problem',
    reduction_map: Array.from({ length: 8 }, (_, index) => ({
      source: `source-${index}`,
      target: `target-${index}`,
      mapping: `mapping-${index}`,
    })),
    assumptions_and_limits: [
      {
        assumption_id: 'a1',
        statement: 'bounded inputs',
        verification_status: 'satisfied',
      },
    ],
    known_solutions: [0, 1].map((index) => ({
      name: `solution-${index}`,
      prerequisites: ['bounded inputs'],
      failure_modes: ['unbounded input'],
      reference_uris: [`https://example.org/solution-${index}`],
    })),
    transfer_plan: [
      {
        step: 'construct map',
        expected_output: 'mapped instance',
        acceptance: 'invariants hold',
      },
    ],
    compatibility_checks: ['dimensional consistency', 'limiting behavior'],
    minimal_toy_check: {
      setup: 'small instance',
      expected_result: 'known solution',
      pass_fail_criteria: 'exact match',
    },
    kill_criteria: ['mapping violates an invariant'],
  };
}

export function reductionAudit(): Record<string, unknown> {
  return {
    status: 'pass',
    abstract_problem: 'generic inverse problem',
    assumptions: [{ assumption_id: 'a1', status: 'satisfied' }],
    toy_check_result: 'pass',
    reduction_type_valid: true,
    failures: [],
    timestamp: '2026-07-21T07:00:00.000Z',
  };
}

export function logEntries(service: IdeaEngineRpcService, campaignId: string): Array<Record<string, unknown>> {
  return readFileSync(service.read.store.nodesLogPath(campaignId), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function runCli(rootDir: string, params: Record<string, unknown>): { response: Record<string, unknown>; status: number | null } {
  expect(existsSync(distEntry), 'build idea-engine before running process-restart tests').toBe(true);
  const child = spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    input: JSON.stringify({
      method: 'node.revise_card',
      params,
      store_root: rootDir,
    }),
  });
  return {
    response: JSON.parse(child.stdout) as Record<string, unknown>,
    status: child.status,
  };
}

export function crash(rootDir: string, params: Record<string, unknown>, crashPoint: string): number | null {
  expect(existsSync(distEntry), 'build idea-engine before running process-restart tests').toBe(true);
  return spawnSync(process.execPath, [crashDriver], {
    encoding: 'utf8',
    input: JSON.stringify({
      crash_point: crashPoint,
      params,
      root_dir: rootDir,
    }),
  }).status;
}
