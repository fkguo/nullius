/**
 * H-19: RetryPolicy type definition (shared across orchestrator + future AgentRunner).
 */

export interface RetryPolicy {
  /** Maximum number of retries (0 = no retries). */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff. */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. */
  maxDelayMs: number;
  /** Jitter factor (0–1). 0 = no jitter, 1 = full jitter. */
  jitter: number;
}

/** Sensible default per ECOSYSTEM_DEV_CONTRACT: base=1s, max=60s, jitter=±25%, 3 retries. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  jitter: 0.25,
};
