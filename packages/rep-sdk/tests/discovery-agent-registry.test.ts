import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createAgentRegistry } from '../src/discovery/index.js';

async function loadLiveCard(fileName: 'hep-mcp.json' | 'idea-engine.json') {
  const raw = await readFile(
    new URL(
      // These compatibility checks intentionally rely on the full monorepo fixture path.
      `../../hep-autoresearch/src/hep_autoresearch/toolkit/agent_cards/${fileName}`,
      import.meta.url,
    ),
    'utf8',
  );
  return JSON.parse(raw) as unknown;
}

describe('agent registry', () => {
  it('lists and resolves capabilities from validated cards', async () => {
    const registry = createAgentRegistry({
      cards: [await loadLiveCard('hep-mcp.json'), await loadLiveCard('idea-engine.json')],
    });

    const allCards = registry.list();
    const toolsCards = registry.list({ capabilityId: 'mcp.list_tools' });
    const hepCard = registry.resolveCapability('mcp.list_tools');
    const ideaCard = registry.resolveCapability('campaign.status', { agentId: 'idea-engine' });
    const ideaMutationCards = registry.list({ capabilityId: 'campaign.topup' });

    expect(allCards.map((card) => card.agent_id)).toEqual(['hep-mcp', 'idea-engine']);
    expect(toolsCards.map((card) => card.agent_id)).toEqual(['hep-mcp']);
    expect(ideaMutationCards.map((card) => card.agent_id)).toEqual(['idea-engine']);
    expect(hepCard.agent_id).toBe('hep-mcp');
    expect(ideaCard.agent_id).toBe('idea-engine');
    expect(registry.resolveCapability('campaign.complete', { agentId: 'idea-engine' }).agent_id).toBe('idea-engine');
  });

  it('keeps capability resolution stable when consumers destructure the helper', async () => {
    const registry = createAgentRegistry({
      cards: [await loadLiveCard('hep-mcp.json'), await loadLiveCard('idea-engine.json')],
    });
    const { resolveCapability } = registry;

    expect(resolveCapability('mcp.list_tools').agent_id).toBe('hep-mcp');
  });

  it('fails closed on duplicate agent ids, unknown capabilities, and ambiguous matches', async () => {
    const hepCard = await loadLiveCard('hep-mcp.json');
    const ideaCard = await loadLiveCard('idea-engine.json');
    const registry = createAgentRegistry({ cards: [hepCard, ideaCard] });

    const duplicateAdd = registry.add(hepCard);
    expect(duplicateAdd.ok).toBe(false);
    expect(duplicateAdd.issues).toContainEqual(
      expect.objectContaining({
        path: '/agent_id',
        message: expect.stringContaining('Duplicate agent_id'),
      }),
    );

    expect(() => registry.resolveCapability('missing.capability')).toThrow(
      /No agent card found for capability missing\.capability/,
    );

    const ambiguousRegistry = createAgentRegistry({
      cards: [
        hepCard,
        {
          ...(ideaCard as Record<string, unknown>),
          agent_id: 'idea-engine-shadow',
          capabilities: [
            {
              capability_id: 'mcp.list_tools',
              description: 'Shadow capability for ambiguity testing.',
              input_contract_ids: ['idea_runtime_rpc_v1'],
              output_contract_ids: ['idea_runtime_rpc_v1'],
            },
          ],
        },
      ],
    });

    expect(() => ambiguousRegistry.resolveCapability('mcp.list_tools')).toThrow(/ambiguous/);
  });
});
