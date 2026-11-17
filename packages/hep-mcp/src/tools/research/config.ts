/** Shared provider request and input-validation utilities. */

/** Default batch size for parallel API requests */
export const DEFAULT_BATCH_SIZE = 5;

/** Parameter validation limits */
export const VALIDATION_LIMITS = {
  /** Maximum recid value (INSPIRE recids are typically < 3 million) */
  maxRecidValue: 10_000_000,
};

/**
 * Get current year dynamically to avoid stale values in long-running servers
 */
export function getCurrentYear(): number {
  return new Date().getFullYear();
}

/**
 * Validate INSPIRE recid format
 * @returns Error message if invalid, null if valid
 */
export function validateRecid(recid: string): string | null {
  if (!recid || typeof recid !== 'string') {
    return 'recid must be a non-empty string';
  }

  const trimmed = recid.trim();
  if (trimmed.length === 0) {
    return 'recid cannot be empty';
  }

  // INSPIRE recids are numeric
  if (!/^\d+$/.test(trimmed)) {
    return `Invalid recid format: ${recid} (must be numeric)`;
  }

  const numericValue = parseInt(trimmed, 10);
  if (numericValue > VALIDATION_LIMITS.maxRecidValue) {
    return `recid ${recid} exceeds maximum expected value`;
  }

  return null;
}

/**
 * Validate array of recids
 * @returns Error message if invalid, null if valid
 */
export function validateRecids(recids: string[]): string | null {
  if (!Array.isArray(recids)) {
    return 'recids must be an array';
  }

  if (recids.length === 0) {
    return 'recids array cannot be empty';
  }

  for (const recid of recids) {
    const error = validateRecid(recid);
    if (error) {
      return error;
    }
  }

  return null;
}

/**
 * Validate max_depth parameter
 * @returns Clamped value within valid range
 */
export function validateMaxDepth(depth: number | undefined, defaultValue: number = 2): number {
  if (depth === undefined || depth === null) {
    return defaultValue;
  }

  if (typeof depth !== 'number' || isNaN(depth)) {
    return defaultValue;
  }

  const n = Math.trunc(depth);
  return Number.isFinite(n) ? Math.max(0, n) : defaultValue;
}
