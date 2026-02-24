/**
 * LaTeX title cleaning utilities
 * Simplified version for MCP - converts LaTeX math to Unicode
 * Reference: zotero-inspire/src/utils/mathTitle.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// Unicode Maps
// ─────────────────────────────────────────────────────────────────────────────

const SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼',
  '(': '⁽', ')': '⁾', '*': '∗',
  'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ',
  'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ', 'i': 'ⁱ', 'j': 'ʲ',
  'k': 'ᵏ', 'l': 'ˡ', 'm': 'ᵐ', 'n': 'ⁿ', 'o': 'ᵒ',
  'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ',
  'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ',
};

const SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌',
  '(': '₍', ')': '₎',
  'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
  'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ',
  'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ',
  'v': 'ᵥ', 'x': 'ₓ',
};

const GREEK_MAP: Record<string, string> = {
  'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ',
  'epsilon': 'ε', 'zeta': 'ζ', 'eta': 'η', 'theta': 'θ',
  'iota': 'ι', 'kappa': 'κ', 'lambda': 'λ', 'mu': 'μ',
  'nu': 'ν', 'xi': 'ξ', 'pi': 'π', 'rho': 'ρ',
  'sigma': 'σ', 'tau': 'τ', 'upsilon': 'υ', 'phi': 'φ',
  'chi': 'χ', 'psi': 'ψ', 'omega': 'ω',
  'Alpha': 'Α', 'Beta': 'Β', 'Gamma': 'Γ', 'Delta': 'Δ',
  'Epsilon': 'Ε', 'Zeta': 'Ζ', 'Eta': 'Η', 'Theta': 'Θ',
  'Iota': 'Ι', 'Kappa': 'Κ', 'Lambda': 'Λ', 'Mu': 'Μ',
  'Nu': 'Ν', 'Xi': 'Ξ', 'Pi': 'Π', 'Rho': 'Ρ',
  'Sigma': 'Σ', 'Tau': 'Τ', 'Upsilon': 'Υ', 'Phi': 'Φ',
  'Chi': 'Χ', 'Psi': 'Ψ', 'Omega': 'Ω',
};

// ─────────────────────────────────────────────────────────────────────────────
// Conversion Functions
// ─────────────────────────────────────────────────────────────────────────────

function toSuperscript(s: string): string {
  return s.split('').map(c => SUPERSCRIPT_MAP[c] || c).join('');
}

function toSubscript(s: string): string {
  return s.split('').map(c => SUBSCRIPT_MAP[c] || c).join('');
}

function replaceGreekLetters(text: string): string {
  let result = text;
  for (const [name, symbol] of Object.entries(GREEK_MAP)) {
    result = result.replace(new RegExp(`\\\\${name}\\b`, 'g'), symbol);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean LaTeX math expressions in title to Unicode
 * Examples:
 * - "$D_s^+$ meson" → "Dₛ⁺ meson"
 * - "$\\Lambda_b$" → "Λ_b"
 * - "$B^0 \\to K^+ K^-$" → "B⁰ → K⁺ K⁻"
 */
export function cleanMathTitle(title: string): string {
  if (!title || typeof title !== 'string') return title;

  let result = title;

  // Process inline math: $...$
  result = result.replace(/\$([^$]+)\$/g, (_match, math) => {
    return processMathExpression(math);
  });

  // Clean up extra whitespace
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

function processMathExpression(math: string): string {
  let result = math;

  // Replace Greek letters first
  result = replaceGreekLetters(result);

  // Handle superscripts: ^{...} or ^x
  result = result.replace(/\^{([^}]+)}/g, (_m, exp) => toSuperscript(exp));
  result = result.replace(/\^([a-zA-Z0-9+\-*])/g, (_m, exp) => toSuperscript(exp));

  // Handle subscripts: _{...} or _x
  result = result.replace(/_{([^}]+)}/g, (_m, sub) => toSubscript(sub));
  result = result.replace(/_([a-zA-Z0-9+\-])/g, (_m, sub) => toSubscript(sub));

  // Common LaTeX commands
  result = result.replace(/\\to\b/g, '→');
  result = result.replace(/\\rightarrow\b/g, '→');
  result = result.replace(/\\leftarrow\b/g, '←');
  result = result.replace(/\\leftrightarrow\b/g, '↔');
  result = result.replace(/\\pm\b/g, '±');
  result = result.replace(/\\mp\b/g, '∓');
  result = result.replace(/\\times\b/g, '×');
  result = result.replace(/\\cdot\b/g, '·');
  result = result.replace(/\\sim\b/g, '∼');
  result = result.replace(/\\approx\b/g, '≈');
  result = result.replace(/\\leq\b/g, '≤');
  result = result.replace(/\\geq\b/g, '≥');
  result = result.replace(/\\neq\b/g, '≠');
  result = result.replace(/\\infty\b/g, '∞');
  result = result.replace(/\\bar{([^}]+)}/g, '$1̄');
  result = result.replace(/\\overline{([^}]+)}/g, '$1̄');

  // Remove remaining backslashes from unknown commands
  result = result.replace(/\\([a-zA-Z]+)/g, '$1');

  // Clean up braces
  result = result.replace(/[{}]/g, '');

  return result;
}
