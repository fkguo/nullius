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
