import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { IdeaEngineRpcService } from '../src/service/rpc-service.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = resolve(packageRoot, 'bin/idea-rpc.mjs');
const distEntry = resolve(packageRoot, 'dist/index.js');

function runCli(request: Record<string, unknown>): { stdout: string; status: number | null } {
  // The bridge imports ../dist/index.js; failing loudly beats silently
  // skipping when the build has not run yet.
  expect(existsSync(distEntry), 'run `pnpm -C packages/idea-engine build` before the CLI bridge test').toBe(true);
  const child = spawnSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    input: JSON.stringify(request),
  });
  return { stdout: child.stdout, status: child.status };
}

describe('idea-rpc command-line bridge', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('drives a set_posterior round trip through stdin/stdout', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-rpc-cli-'));
    tempDirs.push(rootDir);
    const service = new IdeaEngineRpcService({ rootDir });
    const init = service.handle('campaign.init', {
      budget: { max_cost_usd: 10, max_steps: 5, max_tokens: 10_000, max_wall_clock_s: 3600 },
      charter: {
        approval_gate_ref: 'gate://a0.1',
        domain: 'test-domain',
        scope: 'idea-rpc bridge smoke fixture',
      },
      idempotency_key: 'cli-init',
      seed_pack: { seeds: [{ content: 'seed-a', seed_type: 'text', source_uris: ['https://example.org/a'] }] },
    });
    const campaignId = String(init.campaign_id);
    const nodeId = Object.keys(service.read.store.loadNodes(campaignId))[0]!;

    const { stdout, status } = runCli({
      method: 'node.set_posterior',
      store_root: rootDir,
      params: {
        campaign_id: campaignId,
        idempotency_key: 'cli-sp-1',
        literature_coverage: {
          status: 'saturated',
          survey_ref: `project://artifacts/literature/${nodeId}-literature_survey_v1.json#sha256:${'c'.repeat(64)}`,
          close_prior_matrix_ref: `project://artifacts/literature/${nodeId}-close-prior-matrix.json#sha256:${'d'.repeat(64)}`,
        },
        node_id: nodeId,
        posterior: { evidence_count: 4, value: 0.55 },
      },
    });
    expect(status).toBe(0);
    const response = JSON.parse(stdout) as Record<string, unknown>;
    expect(response.error).toBeUndefined();
    const result = response.result as Record<string, unknown>;
    expect((result.node as Record<string, unknown>).node_id).toBe(nodeId);
    expect(((result.node as Record<string, unknown>).posterior as Record<string, unknown>).value).toBe(0.55);

    const storedNode = service.read.store.loadNodes<Record<string, unknown>>(campaignId)[nodeId]!;
    expect((storedNode.posterior as Record<string, unknown>).value).toBe(0.55);
    expect(storedNode.revision).toBe(2);
  });

  it('returns a JSON-RPC error envelope and non-zero exit for engine errors', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'idea-rpc-cli-err-'));
    tempDirs.push(rootDir);
    const { stdout, status } = runCli({
      method: 'campaign.status',
      store_root: rootDir,
      params: { campaign_id: 'nxcamp99' },
    });
    expect(status).toBe(1);
    const response = JSON.parse(stdout) as Record<string, unknown>;
    expect((response.error as Record<string, unknown>).message).toBe('campaign_not_found');
  });

  it('rejects malformed stdin without touching any store', () => {
    const child = spawnSync(process.execPath, [cliPath], { encoding: 'utf8', input: '{not json' });
    expect(child.status).toBe(1);
    const response = JSON.parse(child.stdout) as Record<string, unknown>;
    expect((response.error as Record<string, unknown>).message).toBe('parse_error');
  });
});
