import {
  formatValidationIssues,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from '../validation/result.js';
import { type AgentCard, validateAgentCard } from './agent-card.js';

export interface CreateAgentRegistryOptions {
  cards?: unknown[];
}

export interface AgentRegistryListOptions {
  capabilityId?: string;
}

export interface ResolveCapabilityOptions {
  agentId?: string;
}

export interface AgentRegistry {
  add(input: unknown): ValidationResult<AgentCard>;
  get(agentId: string): AgentCard | undefined;
  list(options?: AgentRegistryListOptions): AgentCard[];
  resolveCapability(capabilityId: string, options?: ResolveCapabilityOptions): AgentCard;
}

export function createAgentRegistry(options: CreateAgentRegistryOptions = {}): AgentRegistry {
  const cardsById = new Map<string, AgentCard>();

  for (const card of options.cards ?? []) {
    const added = add(card);
    if (!added.ok) {
      throw new Error(`Invalid initial agent card: ${formatValidationIssues(added.issues)}`);
    }
  }

  function get(agentId: string): AgentCard | undefined {
    return cardsById.get(agentId.trim());
  }

  function list(listOptions: AgentRegistryListOptions = {}): AgentCard[] {
    const capabilityId = listOptions.capabilityId?.trim();
    return [...cardsById.values()]
      .filter((card) =>
        capabilityId
          ? card.capabilities.some((capability) => capability.capability_id === capabilityId)
          : true,
      )
      .sort((left, right) => left.agent_id.localeCompare(right.agent_id));
  }

  function resolveCapability(
    capabilityId: string,
    resolveOptions: ResolveCapabilityOptions = {},
  ): AgentCard {
    const capability = capabilityId.trim();
    const agentId = resolveOptions.agentId?.trim();
    const matches = list({ capabilityId: capability }).filter((card) =>
      agentId ? card.agent_id === agentId : true,
    );

    if (matches.length === 0) {
      const suffix = agentId ? ` and agent ${agentId}` : '';
      throw new Error(`No agent card found for capability ${capability}${suffix}.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Capability ${capability} is ambiguous across agent ids: ${matches
          .map((card) => card.agent_id)
          .join(', ')}.`,
      );
    }
    return matches[0];
  }

  return {
    add,
    get,
    list,
    resolveCapability,
  };

  function add(input: unknown): ValidationResult<AgentCard> {
    const validation = validateAgentCard(input);
    if (!validation.ok || !validation.data) {
      return validation;
    }

    if (cardsById.has(validation.data.agent_id)) {
      return validationFailure([
        {
          path: '/agent_id',
          message: `Duplicate agent_id: ${validation.data.agent_id}.`,
        },
      ]);
    }

    cardsById.set(validation.data.agent_id, validation.data);
    return validationSuccess(validation.data);
  }
}
