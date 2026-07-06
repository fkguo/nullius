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
    ]);
    expect(IDEA_TOOLS.map(tool => tool.rpcMethod)).toEqual([
      'campaign.init',
      'campaign.status',
      'campaign.topup',
      'campaign.pause',
      'campaign.resume',
      'campaign.complete',
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

  it('exposes live-contract required fields for the campaign mutation tools', () => {
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
      // B-10: complete is destructive — _confirm must be in required so
      // ListTools clients see the gate without out-of-band documentation.
      required: ['campaign_id', 'idempotency_key', '_confirm'],
    });
  });

  it('rejects the old shorthand request shapes from batch-9', () => {
    expect(() => getTool('idea_campaign_init').schema.parse({
      topic: 'a shorthand topic',
      budget: 5,
    })).toThrow();

    expect(() => getTool('idea_campaign_topup').schema.parse({
      campaign_id: 'c4mp41gn',
      topup: {},
      idempotency_key: 'empty-topup',
    })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B-10 regression — destructive tool gate via `_confirm: true`
// Source of bug: idea-mcp's server bypassed the shared dispatcher's
// _confirm enforcement; IdeaToolDef had no riskLevel field; campaign.complete
// could be invoked without confirmation.
//
// Defense:
//   - IdeaToolDef gains `riskLevel: 'read' | 'write' | 'destructive'`
//   - Destructive tool schemas are augmented with `_confirm: z.literal(true)`
//   - Per Batch-9 rule: only complete is destructive (irreversible terminal
//     state). pause/resume are reversible → `write`. status is read-only.
// ─────────────────────────────────────────────────────────────────────────────
describe('B-10 regression — destructive tool gate', () => {
  it('classifies every tool with a riskLevel', () => {
    for (const tool of IDEA_TOOLS) {
      expect(tool.riskLevel, `tool ${tool.name} must have riskLevel`).toMatch(/^(read|write|destructive)$/);
    }
  });

  it('marks only idea_campaign_complete as destructive (per MEMORY Batch-9 downgrade rule)', () => {
    const byRisk: Record<string, string[]> = { read: [], write: [], destructive: [] };
    for (const tool of IDEA_TOOLS) {
      byRisk[tool.riskLevel].push(tool.name);
    }
    expect(byRisk.destructive).toEqual(['idea_campaign_complete']);
    expect(byRisk.read).toEqual(['idea_campaign_status']);
    // The 6 remaining tools are write-class (idempotent or reversible)
    expect(byRisk.write.length).toBe(IDEA_TOOLS.length - 2);
  });

  it('idea_campaign_complete schema REJECTS missing _confirm', () => {
    const tool = getTool('idea_campaign_complete');
    expect(() => tool.schema.parse({
      campaign_id: 'c4mp41gn',
      idempotency_key: 'complete-without-confirm',
    })).toThrow();
  });

  it('idea_campaign_complete schema REJECTS _confirm: false', () => {
    const tool = getTool('idea_campaign_complete');
    expect(() => tool.schema.parse({
      campaign_id: 'c4mp41gn',
      idempotency_key: 'complete-with-false',
      _confirm: false,
    })).toThrow();
  });

  it('idea_campaign_complete schema REJECTS _confirm: "true" (string, not boolean)', () => {
    const tool = getTool('idea_campaign_complete');
    expect(() => tool.schema.parse({
      campaign_id: 'c4mp41gn',
      idempotency_key: 'complete-with-string',
      _confirm: 'true',
    })).toThrow();
  });

  it('idea_campaign_complete schema ACCEPTS _confirm: true', () => {
    const tool = getTool('idea_campaign_complete');
    const parsed = tool.schema.parse({
      campaign_id: 'c4mp41gn',
      idempotency_key: 'complete-with-confirm',
      _confirm: true,
    });
    // Verify the parsed object DOES carry _confirm (server strips it later
    // before forwarding to rpc.call — see server.test.ts for that lock).
    expect(parsed).toMatchObject({
      campaign_id: 'c4mp41gn',
      idempotency_key: 'complete-with-confirm',
      _confirm: true,
    });
  });

  it('non-destructive tool schemas REJECT _confirm (strict-unknown contract preserved)', () => {
    // The strict() guard means passing _confirm to a non-destructive tool
    // is a contract violation — caught at parse, with no silent acceptance.
    for (const name of ['idea_campaign_status', 'idea_campaign_pause', 'idea_campaign_resume']) {
      const tool = getTool(name);
      expect(
        () => tool.schema.parse({
          campaign_id: 'c4mp41gn',
          idempotency_key: 'unused',
          _confirm: true,
        }),
        `tool ${name} should reject _confirm`,
      ).toThrow();
    }
  });

  it('ListTools-exposed JSON schema for destructive tool advertises _confirm as required', () => {
    const schema = zodToMcpInputSchema(getTool('idea_campaign_complete').schema) as Record<string, unknown>;
    const required = schema.required as string[];
    expect(required).toContain('_confirm');
    const properties = schema.properties as Record<string, unknown>;
    expect(properties._confirm).toBeDefined();
    // ListTools must NOT expose _confirm for non-destructive tools
    const pauseSchema = zodToMcpInputSchema(getTool('idea_campaign_pause').schema) as Record<string, unknown>;
    const pauseRequired = pauseSchema.required as string[];
    expect(pauseRequired).not.toContain('_confirm');
  });
});
