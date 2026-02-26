/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Wire protocol envelope for the Research Evolution Protocol (REP). Adapted from GEP a2aProtocol.js envelope format. All REP messages are wrapped in this envelope.
 */
export interface REPEnvelopeV1 {
  /**
   * Protocol identifier. Always 'rep-a2a' for REP messages.
   */
  protocol: "rep-a2a";
  /**
   * Protocol version (e.g., '1.0').
   */
  protocol_version: string;
  /**
   * Type of REP message. 'hello' for capability advertisement. 'publish' for publishing strategies/outcomes. 'fetch' for requesting strategies. 'report' for reporting events/results. 'review' for peer review decisions. 'revoke' for revoking published assets.
   */
  message_type: "hello" | "publish" | "fetch" | "report" | "review" | "revoke";
  /**
   * Unique message identifier (UUID v4).
   */
  message_id: string;
  /**
   * Identifier of the sending agent/server.
   */
  sender_id: string;
  /**
   * Identifier of the intended recipient. Omitted for broadcast messages.
   */
  recipient_id?: string;
  /**
   * ISO 8601 UTC Z timestamp of message creation.
   */
  timestamp: string;
  /**
   * SHA-256 hex digest of the RFC 8785 (JCS) canonical JSON serialization of the payload field. Used for content addressing and integrity verification.
   */
  content_hash?: string;
  /**
   * Message-type-specific payload. Schema is enforced by the message_type discriminator (see allOf).
   */
  payload: {
    [k: string]: unknown;
  };
  /**
   * Optional message signature. Not required for local FileTransport.
   */
  signature?: {
    /**
     * Signature algorithm. 'none' for local/trusted mode.
     */
    algorithm?: "hmac-sha256" | "none";
    /**
     * Hex-encoded signature value. Required if algorithm is not 'none'.
     */
    value?: string;
    /**
     * Identifier of the signing key.
     */
    key_id?: string;
    [k: string]: unknown;
  };
  /**
   * Trace ID for cross-system correlation.
   */
  trace_id?: string;
}
/**
 * This interface was referenced by `REPEnvelopeV1`'s JSON-Schema
 * via the `definition` "HelloPayload".
 */
export interface HelloPayload {
  /**
   * List of capabilities this agent supports (e.g., ['strategy_publish', 'outcome_report', 'integrity_check']).
   */
  capabilities: string[];
  /**
   * Research domain (e.g., 'hep-th').
   */
  domain: string;
  agent_name?: string;
  agent_version?: string;
  /**
   * Integrity check domains this agent can evaluate.
   */
  supported_check_domains?: string[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `REPEnvelopeV1`'s JSON-Schema
 * via the `definition` "PublishPayload".
 */
export interface PublishPayload {
  /**
   * Type of asset being published.
   */
  asset_type: "strategy" | "outcome" | "integrity_report";
  /**
   * The asset being published. Validated at runtime by the REP SDK against the schema identified by asset_type (strategy→research_strategy_v1, outcome→research_outcome_v1, integrity_report→integrity_report_v1). Follows the CloudEvents dataschema pattern: envelope validates envelope, SDK validates inner payload.
   */
  asset: {
    [k: string]: unknown;
  };
  /**
   * RDI gate evaluation result. Required for outcome publication.
   */
  rdi_gate_result?: {
    passed?: boolean;
    checks?: {
      name?: string;
      passed?: boolean;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  };
  /**
   * Present when this publish is a revision of a previously published asset. Establishes the causal link between a review decision and the resulting revision, completing the audit trail.
   */
  revision_of?: {
    /**
     * Content-addressed ID of the asset being revised.
     */
    original_asset_id: string;
    /**
     * message_id of the review that triggered this revision. Links the causal chain: review -> revision -> re-review.
     */
    review_message_id?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * This interface was referenced by `REPEnvelopeV1`'s JSON-Schema
 * via the `definition` "FetchPayload".
 */
export interface FetchPayload {
  asset_type: "strategy" | "outcome" | "integrity_report";
  /**
   * Optional filters for the fetch query.
   */
  filters?: {
    domain?: string;
    preset?: string;
    status?: string;
    min_rdi_rank?: number;
    since?: string;
    [k: string]: unknown;
  };
  limit?: number;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `REPEnvelopeV1`'s JSON-Schema
 * via the `definition` "ReportPayload".
 */
export interface ReportPayload {
  /**
   * ResearchEvent being reported. Validated at runtime by the REP SDK against research_event_v1.schema.json. Follows the CloudEvents dataschema pattern: envelope validates envelope, SDK validates inner payload.
   */
  event: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * This interface was referenced by `REPEnvelopeV1`'s JSON-Schema
 * via the `definition` "ReviewPayload".
 */
export interface ReviewPayload {
  /**
   * Content-addressed ID of the asset being reviewed.
   */
  target_asset_id: string;
  /**
   * Review decision.
   */
  decision: "approve" | "reject" | "revise";
  /**
   * Structured review comments.
   */
  review_comments?: string;
  reviewer_id?: string;
  /**
   * Reference to integrity report supporting the decision.
   */
  integrity_report_ref?: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `REPEnvelopeV1`'s JSON-Schema
 * via the `definition` "RevokePayload".
 */
export interface RevokePayload {
  /**
   * Content-addressed ID of the asset being revoked.
   */
  target_asset_id: string;
  /**
   * Reason for revocation.
   */
  reason: string;
  /**
   * ID of the asset that supersedes this one (if applicable).
   */
  superseded_by?: string;
  [k: string]: unknown;
}
