/**
 * EcosystemID — Unified cross-component identifier format (H-15a).
 *
 * Format: `{prefix}_{opaque}` where prefix is a registered snake_case
 * namespace and opaque is a URL-safe, filesystem-safe string.
 *
 * Examples: `run_a1b2c3d4`, `proj_550e8400`, `art_myfile.json`
 */

// ── Prefix Registry ──────────────────────────────────────────────────────────

/**
 * Registered ID prefixes. Each maps a domain concept to a short snake_case tag.
 * New prefixes MUST be added here — ad-hoc prefixes are invalid.
 */
export const ECOSYSTEM_ID_PREFIXES = {
  /** Project */
  proj: 'proj',
  /** Run */
  run: 'run',
  /** Artifact */
  art: 'art',
  /** Event */
  evt: 'evt',
  /** Signal */
  sig: 'sig',
  /** Gate */
  gate: 'gate',
  /** Step (within a run) */
  step: 'step',
  /** Campaign */
  camp: 'camp',
} as const;

export type EcosystemIdPrefix = keyof typeof ECOSYSTEM_ID_PREFIXES;

const VALID_PREFIXES = new Set<string>(Object.keys(ECOSYSTEM_ID_PREFIXES));

// ── Format Constraints ───────────────────────────────────────────────────────

/**
 * The opaque portion (after prefix_) must be:
 * - 1–200 chars
 * - URL-safe & filesystem-safe: alphanumeric, hyphen, underscore, dot
 * - No path separators, no `..`, no null bytes
 */
const OPAQUE_RE = /^[a-zA-Z0-9._-]{1,200}$/;

/**
 * Full EcosystemID pattern: `prefix_opaque`
 * prefix = lowercase alpha + optional digits (registered in ECOSYSTEM_ID_PREFIXES)
 */
const ECOSYSTEM_ID_RE = /^([a-z][a-z0-9]*)_([a-zA-Z0-9._-]{1,200})$/;

// ── Types ────────────────────────────────────────────────────────────────────

/** A validated ecosystem identifier string. Branded for type safety. */
export type EcosystemId = string & { readonly __brand: 'EcosystemId' };

export interface ParsedEcosystemId {
  prefix: EcosystemIdPrefix;
  opaque: string;
  raw: EcosystemId;
}

// ── Validation ───────────────────────────────────────────────────────────────

export class EcosystemIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcosystemIdError';
  }
}

/**
 * Validate and parse an ecosystem ID string.
 * @throws EcosystemIdError if the string is not a valid EcosystemID.
 */
export function parseEcosystemId(raw: string): ParsedEcosystemId {
  if (!raw || typeof raw !== 'string') {
    throw new EcosystemIdError('EcosystemID must be a non-empty string');
  }

  const match = ECOSYSTEM_ID_RE.exec(raw);
  if (!match) {
    throw new EcosystemIdError(
      `Invalid EcosystemID format: "${raw}". Expected "{prefix}_{opaque}" where prefix is registered and opaque is alphanumeric/.-_`
    );
  }

  const [, prefix, opaque] = match;

  if (!VALID_PREFIXES.has(prefix)) {
    throw new EcosystemIdError(
      `Unknown EcosystemID prefix: "${prefix}". Registered prefixes: ${[...VALID_PREFIXES].join(', ')}`
    );
  }

  // Guard against `..` in the opaque part (filesystem safety)
  if (opaque.includes('..')) {
    throw new EcosystemIdError(`EcosystemID opaque part must not contain "..": "${opaque}"`);
  }

  return {
    prefix: prefix as EcosystemIdPrefix,
    opaque,
    raw: raw as EcosystemId,
  };
}

/**
 * Check if a string is a valid EcosystemID without throwing.
 */
export function isValidEcosystemId(raw: string): raw is EcosystemId {
  try {
    parseEcosystemId(raw);
    return true;
  } catch {
    return false;
  }
}

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Construct an EcosystemID from a prefix and opaque string.
 * Validates both parts.
 */
export function makeEcosystemId(prefix: EcosystemIdPrefix, opaque: string): EcosystemId {
  if (!VALID_PREFIXES.has(prefix)) {
    throw new EcosystemIdError(`Unknown prefix: "${prefix}"`);
  }
  if (!opaque || !OPAQUE_RE.test(opaque)) {
    throw new EcosystemIdError(
      `Invalid opaque part: "${opaque}". Must be 1-200 chars of [a-zA-Z0-9._-]`
    );
  }
  if (opaque.includes('..')) {
    throw new EcosystemIdError(`Opaque part must not contain "..": "${opaque}"`);
  }
  return `${prefix}_${opaque}` as EcosystemId;
}

/**
 * Validate that a raw opaque string (e.g. existing run_id) is safe for use
 * as the opaque part of an EcosystemID. Does NOT check prefix.
 * Compatible with the existing `assertSafePathSegment` constraints.
 */
export function isValidOpaque(opaque: string): boolean {
  return !!opaque && OPAQUE_RE.test(opaque) && !opaque.includes('..');
}
