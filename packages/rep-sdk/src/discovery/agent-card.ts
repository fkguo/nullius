import type { HelloPayload } from '../model/rep-envelope.js';
import {
  formatValidationIssues,
  validationFailure,
  validationSuccess,
  type ValidationIssue,
  type ValidationResult,
} from '../validation/result.js';
import { getSchemaValidator, toValidationIssues } from '../validation/schema-registry.js';

const agentCardValidator = getSchemaValidator('agent_card_v1');

export interface AgentContractRef {
  contract_id: string;
  format: 'json_schema' | 'openrpc' | 'protocol';
  description: string;
  source_path?: string;
}

export interface AgentCapability {
  capability_id: string;
  description: string;
  input_contract_ids: string[];
  output_contract_ids: string[];
}

export interface AgentCard {
  schema_version: 1;
  agent_id: string;
  name: string;
  description?: string;
  version: string;
  cost_tier: 'low' | 'medium' | 'high' | 'variable';
  capabilities: [AgentCapability, ...AgentCapability[]];
  input_contracts: AgentContractRef[];
  output_contracts: AgentContractRef[];
}

export interface CreateHelloPayloadFromCardOptions {
  domain: string;
  supportedCheckDomains?: string[];
}

export function validateAgentCard(input: unknown): ValidationResult<AgentCard> {
  if (!agentCardValidator(input)) {
    return validationFailure(toValidationIssues(agentCardValidator.errors));
  }

  const card = input as AgentCard;
  const issues = [
    ...validateContractRefs('/input_contracts', card.input_contracts),
    ...validateContractRefs('/output_contracts', card.output_contracts),
    ...validateCapabilities(card),
  ];
  if (issues.length > 0) {
    return validationFailure(issues);
  }
  return validationSuccess(card);
}

export function createHelloPayloadFromCard(
  card: AgentCard,
  options: CreateHelloPayloadFromCardOptions,
): HelloPayload {
  const validation = validateAgentCard(card);
  if (!validation.ok || !validation.data) {
    throw new Error(`Invalid agent card: ${formatValidationIssues(validation.issues)}`);
  }

  const domain = options.domain.trim();
  if (!domain) {
    throw new Error('Hello payload domain must be a non-empty string.');
  }

  const supportedCheckDomains = (options.supportedCheckDomains ?? [])
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  return {
    capabilities: validation.data.capabilities.map((capability) => capability.capability_id),
    domain,
    agent_name: validation.data.name,
    agent_version: validation.data.version,
    ...(supportedCheckDomains.length > 0 ? { supported_check_domains: supportedCheckDomains } : {}),
  };
}

function validateContractRefs(
  path: '/input_contracts' | '/output_contracts',
  refs: AgentContractRef[],
): ValidationIssue[] {
  const seen = new Set<string>();
  return refs.flatMap((ref, index) => {
    if (!seen.has(ref.contract_id)) {
      seen.add(ref.contract_id);
      return [];
    }
    return [{ path: `${path}/${index}/contract_id`, message: `Duplicate contract_id: ${ref.contract_id}.` }];
  });
}

function validateCapabilities(card: AgentCard): ValidationIssue[] {
  const seenCapabilities = new Set<string>();
  const inputContracts = new Set(card.input_contracts.map((ref) => ref.contract_id));
  const outputContracts = new Set(card.output_contracts.map((ref) => ref.contract_id));

  return card.capabilities.flatMap((capability, index) => {
    const issues: ValidationIssue[] = [];
    if (seenCapabilities.has(capability.capability_id)) {
      issues.push({
        path: `/capabilities/${index}/capability_id`,
        message: `Duplicate capability_id: ${capability.capability_id}.`,
      });
    } else {
      seenCapabilities.add(capability.capability_id);
    }

    issues.push(
      ...validateCapabilityContractRefs(
        `/capabilities/${index}/input_contract_ids`,
        capability.input_contract_ids,
        inputContracts,
      ),
      ...validateCapabilityContractRefs(
        `/capabilities/${index}/output_contract_ids`,
        capability.output_contract_ids,
        outputContracts,
      ),
    );
    return issues;
  });
}

function validateCapabilityContractRefs(
  path: string,
  contractIds: string[],
  knownContracts: Set<string>,
): ValidationIssue[] {
  return contractIds.flatMap((contractId, index) =>
    knownContracts.has(contractId)
      ? []
      : [{ path: `${path}/${index}`, message: `Unknown contract_id reference: ${contractId}.` }],
  );
}
