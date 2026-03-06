function normalizeQuantityText(input: string): string {
  return input
    .replace(/\\(mathrm|text)\{([^}]*)\}/g, '$2')
    .replace(/\\to/g, '->')
    .replace(/\\alpha\b/gi, ' alpha ')
    .replace(/\\beta\b/gi, ' beta ')
    .replace(/\\gamma\b/gi, ' gamma ')
    .replace(/\\delta\b/gi, ' delta ')
    .replace(/\\eta\b/gi, ' eta ')
    .replace(/\\lambda\b/gi, ' lambda ')
    .replace(/\\mu\b/gi, ' mu ')
    .replace(/\\sigma\b/gi, ' sigma ')
    .replace(/\\tau\b/gi, ' tau ')
    .replace(/\\theta\b/gi, ' theta ')
    .replace(/[{}$]/g, ' ')
    .replace(/[αΑ]/g, ' alpha ')
    .replace(/[βΒ]/g, ' beta ')
    .replace(/[γΓ]/g, ' gamma ')
    .replace(/[Δδ]/g, ' delta ')
    .replace(/[ηΗ]/g, ' eta ')
    .replace(/[Λλ]/g, ' lambda ')
    .replace(/[μΜ]/g, ' mu ')
    .replace(/[σΣ]/g, ' sigma ')
    .replace(/[τΤ]/g, ' tau ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function tokenizeQuantityText(text: string): string[] {
  return normalizeQuantityText(text)
    .replace(/[^a-z0-9_:+->]+/g, ' ')
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

export function tokenOverlapRatio(leftTokens: string[], rightTokens: string[]): number {
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  const rightSet = new Set(rightTokens);
  const overlap = new Set<string>();
  for (const token of leftTokens) {
    if (rightSet.has(token)) overlap.add(token);
  }
  const denom = Math.max(1, Math.min(leftTokens.length, rightTokens.length));
  return Math.max(0, Math.min(1, overlap.size / denom));
}

export function looksLikeSingleSymbol(quantity: string): boolean {
  const trimmed = quantity.trim();
  if (!trimmed) return false;
  const cleaned = trimmed.replace(/\\[a-zA-Z]+/g, '').replace(/[{}$]/g, '').trim();
  return cleaned.length > 0 && cleaned.length <= 3 && !/[0-9]/.test(cleaned) && !/\s/.test(cleaned);
}

export function hasDescriptiveContext(context: string): boolean {
  const normalized = normalizeQuantityText(context);
  if (!normalized) return false;
  const generic = new Set(['generic', 'denote', 'symbol', 'observable', 'parameter', 'throughout']);
  const tokens = tokenizeQuantityText(normalized);
  const informative = tokens.filter(token => token.length >= 4 && !generic.has(token));
  return informative.length >= 2;
}

export function normalizeForMatching(text: string): string {
  return normalizeQuantityText(text);
}
