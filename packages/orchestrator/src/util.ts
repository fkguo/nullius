// Shared utility functions for @autoresearch/orchestrator.

/** UTC ISO timestamp with Z suffix, no milliseconds (matching Python utc_now_iso). */
export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
