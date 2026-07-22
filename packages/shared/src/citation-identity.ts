/**
 * Deterministic citation-display to canonical-metadata binding.
 *
 * This is deliberately offline. Callers obtain authoritative metadata through
 * a provider or citation-triangulation, archive the exact response when needed,
 * and record its hash here. The evaluator then proves that the title, optional
 * author list, identifier, URL, and evidence URI shown to a reader all denote
 * the same canonical work. Full-text support is a separate check and cannot
 * compensate for an identity mismatch.
 */

export const CITATION_METADATA_PROVENANCE_KINDS = [
  'archived_canonical_metadata',
  'authoritative_retrieval',
  'citation_triangulation',
] as const;

export type CitationMetadataProvenanceKind = (typeof CITATION_METADATA_PROVENANCE_KINDS)[number];

export const CITATION_IDENTITY_VERDICTS = ['matched', 'mismatch', 'metadata_unavailable'] as const;

export type CitationIdentityVerdict = (typeof CITATION_IDENTITY_VERDICTS)[number];

export const CITATION_IDENTITY_DIAGNOSTIC_CODES = [
  'canonical_metadata_unavailable',
  'title_mismatch',
  'authors_unavailable',
  'authors_mismatch',
  'displayed_identifier_mismatch',
  'displayed_url_mismatch',
  'evidence_uri_mismatch',
] as const;

export type CitationIdentityDiagnosticCode = (typeof CITATION_IDENTITY_DIAGNOSTIC_CODES)[number];

export type CitationDisplayedMetadata = {
  title: string;
  authors?: string[];
  identifier: string;
  url: string;
};

export type CitationMetadataProvenance = {
  kind: CitationMetadataProvenanceKind;
  provider: string;
  /** Stable URI for the exact provider response or triangulation report. */
  record_ref: string;
  /** SHA-256 of the exact archived/retrieved metadata bytes. */
  record_sha256: string;
};

export type CitationCanonicalMetadata = {
  title: string;
  authors?: string[];
  identifier: string;
  url: string;
  /** Other identifiers or URLs that the canonical provider explicitly binds
   *  to the same work. Shared code does not infer provider-specific aliases. */
  locator_aliases?: string[];
  provenance: CitationMetadataProvenance;
};

export type CitationIdentityInput = {
  /** The evidence URI used by the grounding entry. */
  evidence_uri: string;
  /** Bibliographic metadata actually shown to the human reader. */
  displayed: CitationDisplayedMetadata;
  /** Canonical provider/triangulation metadata, when available. */
  canonical?: CitationCanonicalMetadata;
  /** Required when canonical metadata could not be archived or retrieved. */
  unavailable_reason?: string;
};

export type CitationIdentityDiagnostic = {
  code: CitationIdentityDiagnosticCode;
  message: string;
};

export type CitationIdentityCheck = {
  input: CitationIdentityInput;
  /** Derived by evaluateCitationIdentity; never caller-authoritative. */
  verdict: CitationIdentityVerdict;
  /** Derived in deterministic evaluation order: mismatches, then unavailable fields. */
  diagnostics: CitationIdentityDiagnostic[];
};

const GREEK_NAMES = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho',
  'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
] as const;
const GREEK_LOWER = [...'αβγδεζηθικλμνξοπρστυφχψω'];
const GREEK_UPPER = [...'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ'];
const GREEK_CHAR_TO_NAME = new Map<string, string>();
for (const [index, name] of GREEK_NAMES.entries()) {
  GREEK_CHAR_TO_NAME.set(GREEK_LOWER[index]!, name);
  GREEK_CHAR_TO_NAME.set(GREEK_UPPER[index]!, name);
}
GREEK_CHAR_TO_NAME.set('ς', 'sigma');
GREEK_CHAR_TO_NAME.set('ϵ', 'epsilon');
GREEK_CHAR_TO_NAME.set('ϑ', 'theta');
GREEK_CHAR_TO_NAME.set('ϕ', 'phi');
GREEK_CHAR_TO_NAME.set('ϱ', 'rho');

const LATEX_SYMBOL_NAMES = new Set<string>([
  ...GREEK_NAMES,
  'varepsilon', 'vartheta', 'varphi', 'varrho', 'varsigma',
]);
const LATEX_WRAPPERS = new Set([
  'text', 'textrm', 'textit', 'textbf', 'textsc', 'mathrm', 'mathbf',
  'mathit', 'mathcal', 'mathsf', 'mathtt', 'mathbb', 'mathfrak', 'emph',
  'operatorname', 'mbox', 'hbox', 'ensuremath', 'left', 'right',
]);
const LATEX_SYMBOL_ALIASES: Record<string, string> = {
  varepsilon: 'epsilon',
  vartheta: 'theta',
  varphi: 'phi',
  varrho: 'rho',
  varsigma: 'sigma',
};

/** Title folding compatible with citation-triangulation's comparison shape:
 * case/spacing/punctuation, Unicode accents, Greek symbols, and common LaTeX
 * wrappers are normalized without erasing distinct non-ASCII letters. */
export function normalizeCitationTitle(value: string): string {
  let text = [...value].map(character => {
    const greek = GREEK_CHAR_TO_NAME.get(character);
    return greek ? ` ${greek} ` : character;
  }).join('');
  text = text.replace(/\\([A-Za-z]+)\*?\s*/g, (_match, rawName: string) => {
    const name = rawName.toLowerCase();
    if (LATEX_SYMBOL_NAMES.has(name)) return ` ${LATEX_SYMBOL_ALIASES[name] ?? name} `;
    if (LATEX_WRAPPERS.has(name)) return ' ';
    return ' ';
  });
  return text
    .replace(/[${}~]/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AUTHOR_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
const AUTHOR_PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'dos',
  'das', 'du', 'la', 'le', 'lo', 'ter', 'ten', 'af', 'av', 'zu', 'bin',
  'ibn', 'el', 'al',
]);

function isAuthorSuffix(value: string): boolean {
  return AUTHOR_SUFFIXES.has(value.toLowerCase().replace(/\.$/, ''));
}

/** Compare author lists by ordered family-name sequence. Initials versus full
 * given names are intentionally ignored; count and family order remain strict. */
export function normalizeCitationAuthorFamily(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const commaParts = trimmed.split(',').map(part => part.trim()).filter(Boolean);
  let family: string;
  if (commaParts.length > 1 && !commaParts.slice(1).every(isAuthorSuffix)) {
    family = commaParts[0]!;
  } else {
    const tokens = (commaParts[0] ?? trimmed).split(/\s+/).filter(Boolean);
    while (tokens.length > 1 && isAuthorSuffix(tokens[tokens.length - 1]!)) tokens.pop();
    let start = Math.max(0, tokens.length - 1);
    while (start > 0 && AUTHOR_PARTICLES.has(tokens[start - 1]!.toLowerCase())) start -= 1;
    family = tokens.slice(start).join(' ');
  }
  return normalizeCitationTitle(family).replace(/\s+/g, '');
}

function normalizeUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Reduce an identifier or URL to a provider-neutral comparison key. Provider
 * aliases (for example a preprint identifier and a journal URL for one work)
 * must be supplied explicitly in canonical metadata; shared code never guesses
 * that two provider-specific locator shapes are equivalent. */
export function canonicalizeCitationLocator(value: string): string {
  const trimmed = value.trim();
  const url = normalizeUrl(trimmed);
  return url ? `url:${url}` : `identifier:${trimmed.normalize('NFKC')}`;
}

/** All locator spellings that canonical metadata explicitly says denote the
 * same work. */
export function canonicalCitationLocatorKeys(
  metadata: Pick<CitationCanonicalMetadata, 'identifier' | 'url' | 'locator_aliases'>,
): Set<string> {
  return new Set(
    [metadata.identifier, metadata.url, ...(metadata.locator_aliases ?? [])]
      .map(canonicalizeCitationLocator),
  );
}

function diagnostic(code: CitationIdentityDiagnosticCode, message: string): CitationIdentityDiagnostic {
  return { code, message };
}

function canEvaluateCitationIdentity(value: unknown): value is CitationIdentityInput {
  if (!isObject(value) || !nonEmptyString(value.evidence_uri) || !isObject(value.displayed)) return false;
  const displayed = value.displayed;
  if (
    !nonEmptyString(displayed.title)
    || !nonEmptyString(displayed.identifier)
    || !nonEmptyString(displayed.url)
    || (displayed.authors !== undefined
      && (!Array.isArray(displayed.authors) || !displayed.authors.every(nonEmptyString)))
  ) return false;
  if (value.canonical === undefined) return true;
  if (!isObject(value.canonical)) return false;
  const canonical = value.canonical;
  return nonEmptyString(canonical.title)
    && nonEmptyString(canonical.identifier)
    && nonEmptyString(canonical.url)
    && (canonical.authors === undefined
      || (Array.isArray(canonical.authors) && canonical.authors.every(nonEmptyString)))
    && (canonical.locator_aliases === undefined
      || (Array.isArray(canonical.locator_aliases) && canonical.locator_aliases.every(nonEmptyString)));
}

/** Pure identity comparison. Input shape validation is performed by the report
 * parser; this function derives only the load-bearing verdict and diagnostics. */
export function evaluateCitationIdentity(input: CitationIdentityInput): CitationIdentityCheck {
  if (!canEvaluateCitationIdentity(input)) {
    return {
      input,
      verdict: 'metadata_unavailable',
      diagnostics: [diagnostic(
        'canonical_metadata_unavailable',
        'citation metadata input is malformed and cannot be evaluated',
      )],
    };
  }
  if (!input.canonical) {
    return {
      input,
      verdict: 'metadata_unavailable',
      diagnostics: [diagnostic(
        'canonical_metadata_unavailable',
        `canonical metadata unavailable for ${input.evidence_uri}: ${input.unavailable_reason ?? 'no reason recorded'}`,
      )],
    };
  }

  const mismatchDiagnostics: CitationIdentityDiagnostic[] = [];
  const unavailableDiagnostics: CitationIdentityDiagnostic[] = [];
  const canonical = input.canonical;
  if (normalizeCitationTitle(input.displayed.title) !== normalizeCitationTitle(canonical.title)) {
    mismatchDiagnostics.push(diagnostic(
      'title_mismatch',
      `displayed title does not match canonical metadata for ${input.evidence_uri}`,
    ));
  }
  if (input.displayed.authors !== undefined) {
    if (canonical.authors === undefined) {
      unavailableDiagnostics.push(diagnostic(
        'authors_unavailable',
        `canonical author metadata is unavailable for displayed authors at ${input.evidence_uri}`,
      ));
    } else {
      const displayedAuthors = input.displayed.authors.map(normalizeCitationAuthorFamily);
      const canonicalAuthors = canonical.authors.map(normalizeCitationAuthorFamily);
      if (JSON.stringify(displayedAuthors) !== JSON.stringify(canonicalAuthors)) {
        mismatchDiagnostics.push(diagnostic(
          'authors_mismatch',
          `displayed authors do not match canonical metadata for ${input.evidence_uri}`,
        ));
      }
    }
  }

  const canonicalLocators = canonicalCitationLocatorKeys(canonical);
  if (!canonicalLocators.has(canonicalizeCitationLocator(input.displayed.identifier))) {
    mismatchDiagnostics.push(diagnostic(
      'displayed_identifier_mismatch',
      `displayed identifier does not match canonical metadata for ${input.evidence_uri}`,
    ));
  }
  if (!canonicalLocators.has(canonicalizeCitationLocator(input.displayed.url))) {
    mismatchDiagnostics.push(diagnostic(
      'displayed_url_mismatch',
      `displayed URL does not match canonical metadata for ${input.evidence_uri}`,
    ));
  }
  if (!canonicalLocators.has(canonicalizeCitationLocator(input.evidence_uri))) {
    mismatchDiagnostics.push(diagnostic(
      'evidence_uri_mismatch',
      `grounding evidence URI does not match canonical metadata for ${input.evidence_uri}`,
    ));
  }

  const diagnostics = [...mismatchDiagnostics, ...unavailableDiagnostics];
  return {
    input,
    verdict: mismatchDiagnostics.length > 0
      ? 'mismatch'
      : unavailableDiagnostics.length > 0
        ? 'metadata_unavailable'
        : 'matched',
    diagnostics,
  };
}

export type CitationIdentityParseIssue = { path: string; message: string };
type CitationIdentityParseSuccess = { ok: true; value: CitationIdentityCheck };
type CitationIdentityParseFailure = { ok: false; issues: CitationIdentityParseIssue[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAuthors(value: unknown, path: string, issues: CitationIdentityParseIssue[]): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0 || !value.every(nonEmptyString)) {
    issues.push({ path, message: 'must be a non-empty array of non-empty strings when provided' });
    return false;
  }
  return true;
}

function validateBibliographicMetadata(
  value: unknown,
  path: string,
  issues: CitationIdentityParseIssue[],
  canonical: boolean,
): boolean {
  if (!isObject(value)) {
    issues.push({ path, message: 'must be an object' });
    return false;
  }
  let sound = true;
  for (const field of ['title', 'identifier', 'url'] as const) {
    if (!nonEmptyString(value[field])) {
      issues.push({ path: `${path}.${field}`, message: 'must be a non-empty string' });
      sound = false;
    }
  }
  if (typeof value.title === 'string' && !normalizeCitationTitle(value.title)) {
    issues.push({ path: `${path}.title`, message: 'must normalize to non-empty bibliographic text' });
    sound = false;
  }
  if (!validateAuthors(value.authors, `${path}.authors`, issues)) sound = false;
  if (!canonical) return sound;
  if (value.locator_aliases !== undefined) {
    if (
      !Array.isArray(value.locator_aliases)
      || value.locator_aliases.length === 0
      || !value.locator_aliases.every(nonEmptyString)
    ) {
      issues.push({
        path: `${path}.locator_aliases`,
        message: 'must be a non-empty array of non-empty strings when provided',
      });
      sound = false;
    } else {
      const keys = value.locator_aliases.map(canonicalizeCitationLocator);
      if (new Set(keys).size !== keys.length) {
        issues.push({ path: `${path}.locator_aliases`, message: 'must not contain duplicate locators' });
        sound = false;
      }
    }
  }
  if (!isObject(value.provenance)) {
    issues.push({ path: `${path}.provenance`, message: 'must be an object' });
    return false;
  }
  const provenance = value.provenance;
  if (!CITATION_METADATA_PROVENANCE_KINDS.includes(provenance.kind as CitationMetadataProvenanceKind)) {
    issues.push({
      path: `${path}.provenance.kind`,
      message: `must be one of ${CITATION_METADATA_PROVENANCE_KINDS.join(', ')}`,
    });
    sound = false;
  }
  if (!nonEmptyString(provenance.provider)) {
    issues.push({ path: `${path}.provenance.provider`, message: 'must be a non-empty string' });
    sound = false;
  }
  if (!nonEmptyString(provenance.record_ref) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(provenance.record_ref)) {
    issues.push({ path: `${path}.provenance.record_ref`, message: 'must be a stable non-file URI' });
    sound = false;
  } else if (/^file:\/\//i.test(provenance.record_ref)) {
    issues.push({ path: `${path}.provenance.record_ref`, message: 'must not be a file URI' });
    sound = false;
  }
  if (typeof provenance.record_sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(provenance.record_sha256)) {
    issues.push({ path: `${path}.provenance.record_sha256`, message: 'must be sha256:<64 lowercase hex>' });
    sound = false;
  }
  if (
    (provenance.kind === 'archived_canonical_metadata' || provenance.kind === 'citation_triangulation')
    && typeof provenance.record_ref === 'string'
    && typeof provenance.record_sha256 === 'string'
    && !provenance.record_ref.endsWith(`#${provenance.record_sha256}`)
  ) {
    issues.push({
      path: `${path}.provenance.record_ref`,
      message: 'archived metadata references must end in the matching #sha256:<digest>',
    });
    sound = false;
  }
  return sound;
}

/** Runtime parser for a stored derived check. It re-evaluates the input and
 * rejects hand-edited verdicts or diagnostics. */
export function safeParseCitationIdentityCheck(
  value: unknown,
): CitationIdentityParseSuccess | CitationIdentityParseFailure {
  const issues: CitationIdentityParseIssue[] = [];
  if (!isObject(value)) return { ok: false, issues: [{ path: '', message: 'must be an object' }] };
  if (!isObject(value.input)) {
    issues.push({ path: 'input', message: 'must be an object' });
  } else {
    const input = value.input;
    if (!nonEmptyString(input.evidence_uri)) {
      issues.push({ path: 'input.evidence_uri', message: 'must be a non-empty string' });
    }
    validateBibliographicMetadata(input.displayed, 'input.displayed', issues, false);
    if (input.canonical === undefined) {
      if (!nonEmptyString(input.unavailable_reason)) {
        issues.push({ path: 'input.unavailable_reason', message: 'required when canonical metadata is absent' });
      }
    } else {
      validateBibliographicMetadata(input.canonical, 'input.canonical', issues, true);
      if (input.unavailable_reason !== undefined) {
        issues.push({ path: 'input.unavailable_reason', message: 'must be absent when canonical metadata is present' });
      }
    }
  }
  if (!CITATION_IDENTITY_VERDICTS.includes(value.verdict as CitationIdentityVerdict)) {
    issues.push({ path: 'verdict', message: `must be one of ${CITATION_IDENTITY_VERDICTS.join(', ')}` });
  }
  if (!Array.isArray(value.diagnostics)) {
    issues.push({ path: 'diagnostics', message: 'must be an array' });
  } else {
    value.diagnostics.forEach((item, index) => {
      if (!isObject(item)) {
        issues.push({ path: `diagnostics[${index}]`, message: 'must be an object' });
        return;
      }
      if (!CITATION_IDENTITY_DIAGNOSTIC_CODES.includes(item.code as CitationIdentityDiagnosticCode)) {
        issues.push({
          path: `diagnostics[${index}].code`,
          message: `must be one of ${CITATION_IDENTITY_DIAGNOSTIC_CODES.join(', ')}`,
        });
      }
      if (!nonEmptyString(item.message)) {
        issues.push({ path: `diagnostics[${index}].message`, message: 'must be a non-empty string' });
      }
    });
  }
  if (issues.length === 0) {
    const recomputed = evaluateCitationIdentity(value.input as CitationIdentityInput);
    if (value.verdict !== recomputed.verdict) {
      issues.push({ path: 'verdict', message: `must equal the verdict recomputed from input ('${recomputed.verdict}')` });
    }
    if (JSON.stringify(value.diagnostics) !== JSON.stringify(recomputed.diagnostics)) {
      issues.push({ path: 'diagnostics', message: 'must equal the diagnostics recomputed from input' });
    }
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: value as unknown as CitationIdentityCheck };
}
