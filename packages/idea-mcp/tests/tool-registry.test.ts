import { describe, expect, it } from 'vitest';
import { zodToMcpInputSchema } from '../src/mcp-input-schema.js';
import { IDEA_TOOLS } from '../src/tool-registry.js';

function getTool(name: string) {
  const tool = IDEA_TOOLS.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

describe('idea-mcp tool registry', () => {
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
  });
});
