import { describe, expect, it } from 'vitest';
import { zodToMcpInputSchema } from '../src/mcp-input-schema.js';
import { IDEA_TOOLS } from '../src/tool-registry.js';
import { getFrontDoorAuthoritySurface } from '../../../scripts/lib/front-door-authority-map.mjs';

function getTool(name: string) {
  const tool = IDEA_TOOLS.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

describe('idea-mcp tool registry', () => {
  it('keeps the public inventory aligned with the default idea-engine backend', () => {
    expect(IDEA_TOOLS.map(tool => tool.name)).toEqual([
      'idea_campaign_init',
      'idea_campaign_status',
      'idea_campaign_topup',
      'idea_campaign_pause',
      'idea_campaign_resume',
      'idea_campaign_complete',
      'idea_search_step',
      'idea_eval_run',
    ]);
    expect(IDEA_TOOLS.map(tool => tool.rpcMethod)).toEqual([
      'campaign.init',
      'campaign.status',
      'campaign.topup',
      'campaign.pause',
      'campaign.resume',
      'campaign.complete',
      'search.step',
      'eval.run',
    ]);
  });

  it('locks the public authority map to the exact idea-mcp tool inventory', () => {
    expect(getFrontDoorAuthoritySurface('idea_mcp')).toMatchObject({
      classification: 'canonical_public',
      surface_kind: 'mcp_tool_inventory',
      exact_inventory_source: 'packages/idea-mcp/src/tool-registry.ts',
      tools: IDEA_TOOLS.map(tool => ({
        name: tool.name,
        rpc_method: tool.rpcMethod,
      })),
    });
  });

  it('exposes live-contract required fields for campaign.init', () => {
    const schema = zodToMcpInputSchema(getTool('idea_campaign_init').schema);
    expect(schema).toMatchObject({
      type: 'object',
      required: ['charter', 'seed_pack', 'budget', 'idempotency_key'],
    });
    expect(schema.additionalProperties).toBe(false);
    expect((schema.properties as Record<string, unknown>).abstract_problem_registry).toBeDefined();
  });

  it('exposes live-contract required fields for search.step and eval.run', () => {
    expect(zodToMcpInputSchema(getTool('idea_campaign_topup').schema)).toMatchObject({
      type: 'object',
      required: ['campaign_id', 'topup', 'idempotency_key'],
    });
    expect(zodToMcpInputSchema(getTool('idea_campaign_pause').schema)).toMatchObject({
      type: 'object',
      required: ['campaign_id', 'idempotency_key'],
    });
    expect(zodToMcpInputSchema(getTool('idea_campaign_resume').schema)).toMatchObject({
      type: 'object',
      required: ['campaign_id', 'idempotency_key'],
    });
    expect(zodToMcpInputSchema(getTool('idea_campaign_complete').schema)).toMatchObject({
      type: 'object',
      required: ['campaign_id', 'idempotency_key'],
    });
    expect(zodToMcpInputSchema(getTool('idea_search_step').schema)).toMatchObject({
      type: 'object',
      required: ['campaign_id', 'n_steps', 'idempotency_key'],
    });
    expect(zodToMcpInputSchema(getTool('idea_eval_run').schema)).toMatchObject({
      type: 'object',
      required: ['campaign_id', 'node_ids', 'evaluator_config', 'idempotency_key'],
    });
  });

  it('rejects the old shorthand request shapes from batch-9', () => {
    expect(() => getTool('idea_campaign_init').schema.parse({
      topic: 'dark matter',
      budget: 5,
    })).toThrow();

    expect(() => getTool('idea_search_step').schema.parse({
      campaign_id: 'not-a-uuid',
      query: 'override',
    })).toThrow();

    expect(() => getTool('idea_campaign_topup').schema.parse({
      campaign_id: '11111111-1111-4111-8111-111111111111',
      topup: {},
      idempotency_key: 'empty-topup',
    })).toThrow();
  });
});
