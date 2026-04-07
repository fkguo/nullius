import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createHelloPayloadFromCard, validateAgentCard } from '../src/discovery/index.js';

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

describe('agent card discovery helpers', () => {
  it('validates the live checked-in agent card fixtures', async () => {
    const hepCard = validateAgentCard(await loadLiveCard('hep-mcp.json'));
    const ideaCard = validateAgentCard(await loadLiveCard('idea-engine.json'));

    expect(hepCard.ok).toBe(true);
    expect(ideaCard.ok).toBe(true);
  });

  it('fails closed on duplicate capability ids and unknown contract references', async () => {
    const rawCard = (await loadLiveCard('hep-mcp.json')) as {
      capabilities: Array<{
        capability_id: string;
        description: string;
        input_contract_ids: string[];
        output_contract_ids: string[];
      }>;
    };

    const duplicateCapability = {
      ...rawCard,
      capabilities: [...rawCard.capabilities, { ...rawCard.capabilities[0] }],
    };
    const unknownContract = {
      ...rawCard,
      capabilities: rawCard.capabilities.map((capability, index) =>
        index === 0
          ? { ...capability, input_contract_ids: [...capability.input_contract_ids, 'missing_contract'] }
          : capability,
      ),
    };

    const duplicateResult = validateAgentCard(duplicateCapability);
    const unknownContractResult = validateAgentCard(unknownContract);

    expect(duplicateResult.ok).toBe(false);
    expect(duplicateResult.issues).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining('/capabilities/'),
        message: expect.stringContaining('Duplicate capability_id'),
      }),
    );
    expect(unknownContractResult.ok).toBe(false);
    expect(unknownContractResult.issues).toContainEqual(
      expect.objectContaining({
        path: expect.stringContaining('/input_contract_ids/'),
        message: expect.stringContaining('Unknown contract_id reference'),
      }),
    );
  });

  it('derives hello payloads from validated cards without changing the wire shape', async () => {
    const card = validateAgentCard(await loadLiveCard('idea-engine.json'));
    expect(card.ok).toBe(true);

    const payload = createHelloPayloadFromCard(card.data!, {
      domain: 'theory',
      supportedCheckDomains: ['ward', 'cross-check', 'ward'],
    });

    expect(payload).toEqual({
      capabilities: [
        'campaign.init',
        'campaign.status',
        'search.step',
        'eval.run',
      ],
      domain: 'theory',
      agent_name: 'Idea Engine',
      agent_version: '0.0.1',
      supported_check_domains: ['ward', 'cross-check'],
    });
  });

  it('keeps the live idea-engine card pointed at TS-owned contract authority', async () => {
    const card = validateAgentCard(await loadLiveCard('idea-engine.json'));
    expect(card.ok).toBe(true);

    const data = card.data!;
    expect(data.input_contracts).toContainEqual(
      expect.objectContaining({
        contract_id: 'idea_core_rpc_v1',
        source_path: 'packages/idea-engine/contracts/idea-generator-snapshot/schemas/idea_core_rpc_v1.openrpc.json',
      }),
    );
    expect(data.output_contracts).toContainEqual(
      expect.objectContaining({
        contract_id: 'idea_core_rpc_v1',
        source_path: 'packages/idea-engine/contracts/idea-generator-snapshot/schemas/idea_core_rpc_v1.openrpc.json',
      }),
    );
  });
});
