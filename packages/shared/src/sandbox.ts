/**
 * PDF resource limits for untrusted content (H-12).
 * Shared constant — no node dependencies.
 */
export const PDF_RESOURCE_LIMITS = {
  maxPageCount: 800,
  maxFileSizeMB: 100,
  timeoutMs: 60_000,
} as const;
