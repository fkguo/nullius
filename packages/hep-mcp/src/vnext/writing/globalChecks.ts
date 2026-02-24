export interface UnusedMaterialsResult {
  unused_claims: Array<{ claim_id: string; reason: string }>;
  unused_assets: Array<{ evidence_id: string; reason: string }>;
}

/**
 * Check if an evidence_id is referenced in the document text.
 * Searches for multiple patterns:
 * - Raw evidence_id (e.g., "eq_abc123")
 * - Pointer syntax: Eq[evidence_id], Fig[evidence_id], Table[evidence_id]
 * - LaTeX label/ref variants derived from evidence_id
 */
function isAssetReferenced(evidenceId: string, text: string): boolean {
  if (!evidenceId || !text) return false;

  // Direct evidence_id mention
  if (text.includes(evidenceId)) return true;

  // Pointer syntax: Eq[id], Fig[id], Table[id]
  const pointerPatterns = [
    `Eq[${evidenceId}]`,
    `Fig[${evidenceId}]`,
    `Table[${evidenceId}]`,
  ];
  for (const pattern of pointerPatterns) {
    if (text.includes(pattern)) return true;
  }

  // LaTeX ref patterns: \ref{...evidence_id...}, \eqref{...evidence_id...}
  // Evidence IDs often get transformed into labels like "eq:evidence_id" or "fig:evidence_id"
  const labelVariants = [
    `eq:${evidenceId}`,
    `fig:${evidenceId}`,
    `tab:${evidenceId}`,
    evidenceId.replace(/^eq_/, 'eq:'),
    evidenceId.replace(/^fig_/, 'fig:'),
    evidenceId.replace(/^tab_/, 'tab:'),
  ];
  for (const label of labelVariants) {
    if (text.includes(label)) return true;
  }

  return false;
}

export function detectUnusedMaterials(params: {
  assigned_claim_ids: string[];
  used_claim_ids: string[];
  assigned_asset_ids: string[];
  document_text: string;
}): UnusedMaterialsResult {
  const assignedClaims = new Set(params.assigned_claim_ids.map(String).filter(Boolean));
  const usedClaims = new Set(params.used_claim_ids.map(String).filter(Boolean));

  const unused_claims = Array.from(assignedClaims)
    .filter(id => !usedClaims.has(id))
    .sort()
    .map(claim_id => ({ claim_id, reason: 'No attribution references this claim_id.' }));

  const text = String(params.document_text ?? '');
  const unused_assets = params.assigned_asset_ids
    .map(String)
    .filter(Boolean)
    .filter(evidenceId => !isAssetReferenced(evidenceId, text))
    .sort()
    .map(evidence_id => ({ evidence_id, reason: 'evidence_id not referenced in integrated document text.' }));

  return { unused_claims, unused_assets };
}

export interface TerminologyVariant {
  canonical: string;
  variants: Array<{ term: string; sections: string[] }>;
}

export interface CitationCountCheck {
  target_length: 'short' | 'medium' | 'long';
  total_citations: number;
  unique_citations: number;
  min_required: number;
  suggested: number;
  pass: boolean;
  advisory: 'good' | 'acceptable' | 'needs_improvement';
}

function normalizeCanonical(term: string): string {
  return term
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip LaTeX commands from text to avoid false positives in terminology detection.
 * Removes: \command{...}, \command[...]{...}, and common inline commands.
 */
function stripLatexCommands(text: string): string {
  // Remove \command{content} patterns (recursive-safe for simple cases)
  let result = text;

  // Remove common formatting commands: \textbf{...}, \textit{...}, \emph{...}, etc.
  result = result.replace(/\\(?:textbf|textit|textrm|texttt|textsf|emph|underline|mbox|hbox)\{[^}]*\}/g, '');

  // Remove \cite{...}, \ref{...}, \eqref{...}, \label{...}
  result = result.replace(/\\(?:cite|ref|eqref|label|pageref|autoref|cref|Cref)\{[^}]*\}/g, '');

  // Remove \begin{...} and \end{...}
  result = result.replace(/\\(?:begin|end)\{[^}]*\}/g, '');

  // Remove remaining single backslash commands (e.g., \alpha, \beta)
  result = result.replace(/\\[a-zA-Z]+/g, '');

  return result;
}

/**
 * Heuristic terminology variant detector.
 *
 * - Extracts common 2-4 word phrases (letters/hyphens)
 * - Canonicalizes hyphen/underscore/space and punctuation
 * - Reports canonical phrases that appear with >1 distinct surface forms
 * - Filters out LaTeX command internals to reduce false positives
 */
export function detectTerminologyVariants(params: {
  sections: Array<{ section_number: string; content: string }>;
  min_total_occurrences?: number;
}): TerminologyVariant[] {
  const minTotal = typeof params.min_total_occurrences === 'number' && Number.isFinite(params.min_total_occurrences)
    ? Math.max(1, Math.trunc(params.min_total_occurrences))
    : 2;

  const canonicalToVariants = new Map<string, Map<string, Set<string>>>();
  const canonicalCounts = new Map<string, number>();

  const phraseRe = /\b[A-Za-z][A-Za-z\-_]{2,}(?:\s+[A-Za-z][A-Za-z\-_]{2,}){1,3}\b/g;

  for (const sec of params.sections) {
    // Strip LaTeX commands before extracting phrases to reduce noise
    const content = stripLatexCommands(String(sec.content ?? ''));
    for (const match of content.matchAll(phraseRe)) {
      const term = match[0];
      const canonical = normalizeCanonical(term);
      if (!canonical) continue;

      canonicalCounts.set(canonical, (canonicalCounts.get(canonical) ?? 0) + 1);

      const byVariant = canonicalToVariants.get(canonical) ?? new Map<string, Set<string>>();
      const sections = byVariant.get(term) ?? new Set<string>();
      sections.add(String(sec.section_number));
      byVariant.set(term, sections);
      canonicalToVariants.set(canonical, byVariant);
    }
  }

  const out: TerminologyVariant[] = [];
  for (const [canonical, variantsMap] of canonicalToVariants.entries()) {
    if ((canonicalCounts.get(canonical) ?? 0) < minTotal) continue;
    if (variantsMap.size <= 1) continue;

    out.push({
      canonical,
      variants: Array.from(variantsMap.entries()).map(([term, sections]) => ({ term, sections: Array.from(sections).sort() })),
    });
  }

  return out.sort((a, b) => b.variants.length - a.variants.length);
}

function extractCiteKeys(content: string): string[] {
  const out: string[] = [];
  const text = String(content ?? '');
  for (const match of text.matchAll(/\\cite[a-zA-Z*]*\{([^}]+)\}/g)) {
    const keys = match[1]
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    out.push(...keys);
  }
  return out;
}

export function checkCitationCount(params: {
  target_length: 'short' | 'medium' | 'long';
  sections: Array<{ content: string }>;
}): CitationCountCheck {
  const targets: Record<CitationCountCheck['target_length'], { min: number; suggested: number }> = {
    short: { min: 15, suggested: 25 },
    medium: { min: 30, suggested: 50 },
    long: { min: 80, suggested: 150 },
  };

  const target = targets[params.target_length];
  const citations = params.sections.flatMap(s => extractCiteKeys(s.content));
  const total = citations.length;
  const unique = new Set(citations).size;
  const pass = total >= target.min;

  const advisory: CitationCountCheck['advisory'] =
    total >= target.suggested ? 'good' : pass ? 'acceptable' : 'needs_improvement';

  return {
    target_length: params.target_length,
    total_citations: total,
    unique_citations: unique,
    min_required: target.min,
    suggested: target.suggested,
    pass,
    advisory,
  };
}
