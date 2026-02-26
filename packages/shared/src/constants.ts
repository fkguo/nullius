// Result size thresholds (H-13 Result Handling Reform)
// Reference: Anthropic Context Engineering Guide (2025-09), MCP Spec 2025-06-18

/** Soft limit: results above this are written to artifact (if run_id available) */
export const MAX_INLINE_RESULT_BYTES = 40_000; // ~10K tokens

/** Hard limit: results above this are truncated (no run context fallback) */
export const HARD_CAP_RESULT_BYTES = 80_000; // ~20K tokens

/** M-21: Maximum stdio tool result size before mandatory artifact overflow */
export const STDIO_MAX_RESULT_BYTES = 100 * 1024; // 100 KB
