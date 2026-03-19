/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
export type AgentMessageV1 = {
  schema_version: 1;
  message_id: string;
  trace_id: string;
  run_id: string | null;
  source_agent_id: string;
  target_agent_id: string;
  message_kind: "request" | "response" | "error";
  requested_capability: string;
  payload?: {
    [k: string]: unknown;
  };
  error?: ErrorEnvelope;
} & (
  | {
      message_kind?: "request";
      [k: string]: unknown;
    }
  | {
      message_kind?: "response";
      [k: string]: unknown;
    }
  | {
      message_kind?: "error";
      [k: string]: unknown;
    }
);

/**
 * This interface was referenced by `undefined`'s JSON-Schema
 * via the `definition` "error_envelope".
 */
export interface ErrorEnvelope {
  domain: string;
  code: string;
  message: string;
  retryable: boolean;
  run_id: string | null;
  trace_id: string;
  data: {
    [k: string]: unknown;
  } | null;
}
