/**
 * shortId — compact, human-manageable handle identifiers.
 *
 * Replaces bare UUIDs for *handle* ids (node_id, campaign_id, run_id, …) that a
 * human reads or references. Content-derived ids (sha256 refs, payload/idempotency
 * hashes) are NOT handles and MUST keep their full cryptographic length.
 *
 * Scheme: 8 characters of Crockford base32 (lowercase), i.e. digits + lowercase
 * letters excluding i/l/o/u to avoid visual ambiguity (0/O, 1/l/I). ~40 bits.
 */
/** Crockford base32 (lowercase): 0-9 and a-z minus i, l, o, u. 32 symbols. */
export const SHORT_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Default handle-id length (characters). 8 × log2(32) = 40 bits. */
export const SHORT_ID_LENGTH = 8;

/**
 * JSON-Schema `pattern` string for a short handle id. Put this in schemas in place
 * of `"format": "uuid"`. Kept in sync with the alphabet + length above; the alphabet
 * contains no regex-special characters, so it is safe inside a character class.
 */
export const SHORT_ID_JSON_PATTERN = `^[${SHORT_ID_ALPHABET}]{${SHORT_ID_LENGTH}}$`;

const SHORT_ID_RE = new RegExp(SHORT_ID_JSON_PATTERN);

/**
 * Uniform index in [0, bound) from a CSPRNG. Uses Web Crypto (`globalThis.crypto`)
 * so this module stays platform-agnostic (Node 18+, browsers, edge, Deno) — some
 * consumers (e.g. the tracing layer) must not depend on `node:crypto`. Rejection
 * sampling keeps the distribution uniform for any bound.
 */
function randomIndex(bound: number): number {
  const buf = new Uint8Array(1);
  const limit = 256 - (256 % bound);
  let x: number;
  do {
    globalThis.crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % bound;
}

/**
 * Generate a short handle id (default 8 chars of Crockford base32). Uniform over
 * the alphabet via a CSPRNG. Not collision-checked — see `uniqueShortId` for
 * store-backed use where uniqueness must be guaranteed.
 */
export function shortId(length: number = SHORT_ID_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SHORT_ID_ALPHABET[randomIndex(SHORT_ID_ALPHABET.length)];
  }
  return out;
}

/**
 * Collision-checked short id for store-backed callers: regenerate until `exists(id)`
 * is false. Throws after `maxTries` (a full store would need this) rather than
 * returning a colliding id.
 */
export function uniqueShortId(
  exists: (id: string) => boolean,
  opts?: { length?: number; maxTries?: number },
): string {
  const maxTries = opts?.maxTries ?? 16;
  for (let i = 0; i < maxTries; i += 1) {
    const id = shortId(opts?.length);
    if (!exists(id)) return id;
  }
  throw new Error(`shortId: no free id after ${maxTries} tries (id space exhausted?)`);
}

/** True iff `s` is a well-formed short handle id. */
export function isShortId(s: unknown): s is string {
  return typeof s === 'string' && SHORT_ID_RE.test(s);
}
