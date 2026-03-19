/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
export interface AgentCardV1 {
  schema_version: 1;
  agent_id: string;
  name: string;
  description?: string;
  version: string;
  cost_tier: "low" | "medium" | "high" | "variable";
  /**
   * @minItems 1
   */
  capabilities: [Capability, ...Capability[]];
  input_contracts: ContractRef[];
  output_contracts: ContractRef[];
}
/**
 * This interface was referenced by `AgentCardV1`'s JSON-Schema
 * via the `definition` "capability".
 */
export interface Capability {
  capability_id: string;
  description: string;
  input_contract_ids: string[];
  output_contract_ids: string[];
}
/**
 * This interface was referenced by `AgentCardV1`'s JSON-Schema
 * via the `definition` "contract_ref".
 */
export interface ContractRef {
  contract_id: string;
  format: "json_schema" | "openrpc" | "protocol";
  description: string;
  source_path?: string;
}
