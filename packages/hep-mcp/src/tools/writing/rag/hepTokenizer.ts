/**
 * HEP Tokenizer
 *
 * HEP/LaTeX-aware tokenizer for indexing and retrieval.
 * Handles:
 * - Greek letter normalization
 * - Particle symbol normalization
 * - Synonym expansion
 * - LaTeX command cleanup
 *
 * @module rag/hepTokenizer
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokenizer output with dual paths
 */
export interface TokenizerOutput {
  /** Tokens for indexing (normalized, lowercase) */
  index_tokens: string[];
  /** Display text (for LLM reading) */
  display_text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization Rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HEP symbol normalization rules
 */
const HEP_NORMALIZATIONS: [RegExp, string][] = [
  // Greek letters
  [/\\Gamma_?\{?\*?(\d*)\}?/g, 'Gamma$1'],
  [/\\gamma/g, 'gamma'],
  [/\\alpha/g, 'alpha'],
  [/\\beta/g, 'beta'],
  [/\\delta/g, 'delta'],
  [/\\Delta/g, 'Delta'],
  [/\\epsilon/g, 'epsilon'],
  [/\\eta/g, 'eta'],
  [/\\theta/g, 'theta'],
  [/\\kappa/g, 'kappa'],
  [/\\lambda/g, 'lambda'],
  [/\\Lambda/g, 'Lambda'],
  [/\\mu/g, 'mu'],
  [/\\nu/g, 'nu'],
  [/\\xi/g, 'xi'],
  [/\\Xi/g, 'Xi'],
  [/\\pi/g, 'pi'],
  [/\\Pi/g, 'Pi'],
  [/\\rho/g, 'rho'],
  [/\\sigma/g, 'sigma'],
  [/\\Sigma/g, 'Sigma'],
  [/\\tau/g, 'tau'],
  [/\\phi/g, 'phi'],
  [/\\Phi/g, 'Phi'],
  [/\\chi/g, 'chi'],
  [/\\psi/g, 'psi'],
  [/\\Psi/g, 'Psi'],
  [/\\omega/g, 'omega'],
  [/\\Omega/g, 'Omega'],
  [/\\Upsilon/g, 'Upsilon'],

  // Particle symbols
  [/D\^\{?\*(\+|0|-)\}?/g, 'Dstar$1'],
  [/\\bar\s*D\^?(\d)/g, 'D$1bar'],
  [/\\bar\s*\{?D\}?\^?(\d)/g, 'D$1bar'],
  [/B\^\{?(\+|-)\}?/g, 'B$1'],
  [/K\^\{?(\+|-|0)\}?/g, 'K$1'],
  [/\\pi\^\{?(\+|-|0)\}?/g, 'pi$1'],
  [/J\/\\psi/g, 'Jpsi'],
  [/J\/\$\\psi\$/g, 'Jpsi'],
  [/\\psi\(2S\)/g, 'psi2S'],
  [/\\psi\^\{?prime\}?/g, 'psi2S'],
  [/\\eta_c/g, 'eta_c'],
  [/\\chi_c/g, 'chi_c'],
  [/h_c/g, 'h_c'],

  // Processes
  [/\\to\b/g, '->'],
  [/\\rightarrow/g, '->'],
  [/\\leftarrow/g, '<-'],
  [/\\leftrightarrow/g, '<->'],

  // Labels (preserve for reference tracking)
  [/\\label\{([^}]+)\}/g, 'label:$1'],
  [/\\ref\{([^}]+)\}/g, 'ref:$1'],
  [/\\eqref\{([^}]+)\}/g, 'eqref:$1'],

  // Units (preserve structure)
  [/\\mathrm\{eV\}/g, 'eV'],
  [/\\mathrm\{GeV\}/g, 'GeV'],
  [/\\mathrm\{TeV\}/g, 'TeV'],
  [/\\mathrm\{MeV\}/g, 'MeV'],
  [/\\mathrm\{keV\}/g, 'keV'],
  [/\\mathrm\{barn\}/g, 'barn'],
  [/\\mathrm\{mb\}/g, 'mb'],
  [/\\mathrm\{nb\}/g, 'nb'],
  [/\\mathrm\{pb\}/g, 'pb'],
  [/\\mathrm\{fb\}/g, 'fb'],
  [/\\mathrm\{ab\}/g, 'ab'],
  [/\\mathrm\{(?:μ|\\mu)\\s*b\}/g, 'ub'],
  [/\\mathrm\{ub\}/g, 'ub'],
  [/\\mathrm\{ab\}\^\{?-1\}?/g, 'ab^-1'],
  [/\\mathrm\{fb\}\^\{?-1\}?/g, 'fb^-1'],
  [/\\mathrm\{pb\}\^\{?-1\}?/g, 'pb^-1'],
  [/\\mathrm\{nb\}\^\{?-1\}?/g, 'nb^-1'],
  [/\\mathrm\{mb\}\^\{?-1\}?/g, 'mb^-1'],
  [/\\mathrm\{(?:μ|\\mu)\\s*b\}\^\{?-1\}?/g, 'ub^-1'],
  [/\\mathrm\{ub\}\^\{?-1\}?/g, 'ub^-1'],

  // Common HEP terms
  [/\\sqrt\{s\}/g, 'sqrt_s'],
  [/p_\{?T\}?/g, 'pT'],
  [/E_\{?T\}?/g, 'ET'],
  [/m_\{?([^}]+)\}?/g, 'm_$1'],
];

/**
 * Greek letter to English synonym mapping
 */
const GREEK_SYNONYMS: Record<string, string[]> = {
  sigma: ['sigma', 'scalar_meson', 'cross_section'],
  pi: ['pi', 'pion'],
  rho: ['rho', 'rho_meson'],
  omega: ['omega', 'omega_meson'],
  eta: ['eta', 'eta_meson'],
  phi: ['phi', 'phi_meson'],
  psi: ['psi', 'jpsi', 'charmonium'],
  Upsilon: ['upsilon', 'bottomonium'],
  chi: ['chi', 'chi_c', 'chi_b'],
  Lambda: ['lambda', 'lambda_baryon'],
  Sigma: ['sigma_baryon'],
  Xi: ['xi', 'cascade'],
  Omega: ['omega_baryon'],
  Delta: ['delta', 'delta_baryon'],
  Gamma: ['gamma', 'width', 'decay_width'],
};

/**
 * HEP-specific stopwords to remove
 */
const HEP_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our', 'us',
  'they', 'their', 'them', 'he', 'she', 'him', 'her', 'his', 'hers',
  'which', 'what', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Main Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokenize text for HEP domain
 *
 * @param latex - LaTeX text to tokenize
 * @returns Tokenizer output with index tokens and display text
 */
export function tokenizeHEP(latex: string): TokenizerOutput {
  let indexText = latex;

  // 1. Apply normalization rules
  for (const [pattern, replacement] of HEP_NORMALIZATIONS) {
    indexText = indexText.replace(pattern, replacement);
  }

  // 2. Remove pure formatting commands
  indexText = indexText
    .replace(/\\(?:rm|it|bf|mathrm|mathbf|textbf|textit|textrm)\{([^}]+)\}/g, '$1')
    .replace(/\\(?:mbox|text|hbox)\{([^}]+)\}/g, '$1')
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)/g, '')
    .replace(/\\(?:quad|qquad|,|;|!)/g, ' ')
    .replace(/\\(?:cdot|times)/g, '*')
    .replace(/\\(?:pm|mp)/g, '+-')
    .replace(/\\(?:leq|le)/g, '<=')
    .replace(/\\(?:geq|ge)/g, '>=')
    .replace(/\\(?:neq|ne)/g, '!=')
    .replace(/\\(?:approx|sim)/g, '~')
    .replace(/\\(?:equiv)/g, '===');

  // 3. Remove remaining LaTeX commands (but keep content)
  indexText = indexText
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}$]/g, '')
    .replace(/\^(\w)/g, '^$1')
    .replace(/_(\w)/g, '_$1');

  // 4. Split into tokens
  const rawTokens = indexText
    .split(/[\s,;.()[\]]+/)
    .filter((t) => t.length > 1)
    .map((t) => t.toLowerCase().replace(/['"]/g, ''));

  // 5. Expand Greek letter synonyms
  const expandedTokens: string[] = [];
  for (const token of rawTokens) {
    // Skip stopwords
    if (HEP_STOPWORDS.has(token)) continue;

    expandedTokens.push(token);

    // Check for Greek letter synonyms
    for (const [greek, synonyms] of Object.entries(GREEK_SYNONYMS)) {
      if (token.includes(greek.toLowerCase())) {
        expandedTokens.push(...synonyms);
      }
    }
  }

  // 6. Deduplicate
  const uniqueTokens = [...new Set(expandedTokens)];

  return {
    index_tokens: uniqueTokens,
    display_text: indexText.trim(),
  };
}

/**
 * Strip LaTeX while preserving HEP-critical tokens
 *
 * Used for creating searchable text from LaTeX content
 */
export function stripLatexPreserveHEP(latex: string): string {
  // NOTE: This is a best-effort text normalizer for retrieval/evidence. It does not attempt full macro expansion.
  let text = latex;

  // Balanced-brace command rewriting/removal to avoid leaking label keys and editorial content.
  // This targets commands with a single mandatory {...} argument and supports nested braces inside that argument.
  text = replaceFracCommands(text);
  text = replaceCommandsWithOneGroupArg(text, new Set([
    // Reference-like commands: drop targets entirely.
    'label', 'ref', 'eqref', 'autoref', 'pageref', 'cref', 'subref',
    // Citation commands: drop citekeys entirely.
    'cite', 'citet', 'citep', 'citealt', 'citealp', 'citeauthor', 'citeyear', 'citeyearpar', 'nocite',
    // Metadata commands (scorched-earth): drop entirely.
    'pacs', 'keywords',
    // Wrapper macros seen in the corpus.
    'eq',
    // Editorial/draft macros.
    'fk', 'todo', 'del', 'fixme',
  ]), (name) => {
    if (name === 'eq') return 'Eq.';
    return '';
  });

  return text
    // Drop environment wrappers (keep only content)
    .replace(/\\begin\{[^}]+\}/g, ' ')
    .replace(/\\end\{[^}]+\}/g, ' ')
    // Normalize whitespace-ish LaTeX
    .replace(/~+/g, ' ')
    .replace(/\\\\\*?/g, ' ')
    // Preserve a few common HEP symbols/units before generic command stripping
    .replace(/\\%/g, '%')
    .replace(/\\alpha\s*_\{?\s*s\s*\}?/g, 'alpha_s')
    .replace(/\\Lambda\b/g, 'Lambda')
    .replace(/\\mu\b/g, 'μ')
    // Preserve math symbols in simplified form
    .replace(/\\sqrt\{([^}]+)\}/g, 'sqrt($1)')
    .replace(/\\mathrm\{([^}]+)\}/g, '$1')
    .replace(/\\text\{([^}]+)\}/g, '$1')
    // Preserve subscripts (common in particle physics)
    .replace(/m_\{?([^}]+)\}?/g, 'm_$1')
    .replace(/p_\{?T\}?/g, 'p_T')
    .replace(/E_\{?T\}?/g, 'E_T')
    // Preserve units
    .replace(/\\eV/g, 'eV')
    .replace(/\\keV/g, 'keV')
    .replace(/\\GeV/g, 'GeV')
    .replace(/\\TeV/g, 'TeV')
    .replace(/\\MeV/g, 'MeV')
    .replace(/\\fb/g, 'fb^-1')
    .replace(/\\pb/g, 'pb^-1')
    .replace(/\\ab/g, 'ab^-1')
    .replace(/\\nb/g, 'nb')
    .replace(/\\mb/g, 'mb')
    .replace(/\\ub/g, 'ub')
    .replace(/\\mub\b/g, 'μb')
    .replace(/\\barn\b/g, 'barn')
    // Preserve scientific notation
    .replace(/\\times\s*10\^\{?(-?\d+)\}?/g, '×10^$1')
    // Preserve error notation
    .replace(/\\pm/g, '±')
    // Preserve common significance notation
    .replace(/\\sigma/g, 'sigma')
    // Remove other LaTeX commands
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}]/g, '')
    .replace(/μ\s*b\b/g, 'μb')
    .replace(/\s+/g, ' ')
    .trim();
}

function replaceFracCommands(input: string): string {
  let out = '';
  let i = 0;

  while (i < input.length) {
    if (!input.startsWith('\\frac', i)) {
      out += input[i] ?? '';
      i += 1;
      continue;
    }

    const start = i;
    let cursor = i + '\\frac'.length;
    while (cursor < input.length && /\s/.test(input[cursor]!)) cursor += 1;

    const num = readBalancedGroup(input, cursor);
    if (!num) {
      out += input[start] ?? '';
      i = start + 1;
      continue;
    }

    cursor = num.endIndex;
    while (cursor < input.length && /\s/.test(input[cursor]!)) cursor += 1;

    const den = readBalancedGroup(input, cursor);
    if (!den) {
      out += input.slice(start, num.endIndex);
      i = num.endIndex;
      continue;
    }

    out += `${num.content}/${den.content}`;
    i = den.endIndex;
  }

  return out;
}

function replaceCommandsWithOneGroupArg(
  input: string,
  commandNames: Set<string>,
  replacer: (name: string, arg: string) => string
): string {
  let out = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }

    const nameStart = i + 1;
    let nameEnd = nameStart;
    while (nameEnd < input.length && /[A-Za-z]/.test(input[nameEnd]!)) nameEnd += 1;
    const rawName = input.slice(nameStart, nameEnd);
    if (!rawName) {
      out += ch;
      i += 1;
      continue;
    }

    const name = rawName.toLowerCase();
    if (!commandNames.has(name)) {
      out += input.slice(i, nameEnd);
      i = nameEnd;
      continue;
    }

    let cursor = nameEnd;
    while (cursor < input.length && /\s/.test(input[cursor]!)) cursor += 1;
    if (input[cursor] === '*') {
      cursor += 1;
      while (cursor < input.length && /\s/.test(input[cursor]!)) cursor += 1;
    }

    if (input[cursor] === '[') {
      const close = input.indexOf(']', cursor + 1);
      if (close !== -1) {
        cursor = close + 1;
        while (cursor < input.length && /\s/.test(input[cursor]!)) cursor += 1;
      }
    }

    const group = readBalancedGroup(input, cursor);
    if (!group) {
      out += input.slice(i, nameEnd);
      i = nameEnd;
      continue;
    }

    out += replacer(name, group.content);
    i = group.endIndex;
  }

  return out;
}

function readBalancedGroup(input: string, openIndex: number): { content: string; endIndex: number } | null {
  if (input[openIndex] !== '{') return null;

  let depth = 0;
  for (let i = openIndex; i < input.length; i++) {
    const ch = input[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return { content: input.slice(openIndex + 1, i), endIndex: i + 1 };
      }
    }
  }

  return null;
}

/**
 * Estimate token count for a text
 *
 * Simple estimation: ~4 characters per token on average
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text into sentences (LaTeX-aware)
 *
 * Respects:
 * - LaTeX command integrity
 * - Abbreviations (e.g., "Fig.", "Eq.")
 * - Numbers with decimals
 */
export function splitSentences(text: string): string[] {
  // Replace common abbreviations to protect from splitting
  const protected_text = text
    .replace(/Fig\./g, 'Fig__DOT__')
    .replace(/Eq\./g, 'Eq__DOT__')
    .replace(/Ref\./g, 'Ref__DOT__')
    .replace(/Tab\./g, 'Tab__DOT__')
    .replace(/et al\./g, 'et al__DOT__')
    .replace(/i\.e\./g, 'i__DOT__e__DOT__')
    .replace(/e\.g\./g, 'e__DOT__g__DOT__')
    .replace(/vs\./g, 'vs__DOT__')
    .replace(/(\d)\.(\d)/g, '$1__DOT__$2'); // Protect decimal numbers

  // Split on sentence boundaries
  const sentences = protected_text
    .split(/(?<=[.!?])\s+(?=[A-Z\\])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Restore protected periods
  return sentences.map((s) =>
    s.replace(/__DOT__/g, '.')
  );
}

/**
 * Extract key tokens from a sentence (for support score calculation)
 *
 * Focuses on:
 * - Numbers with units
 * - Particle/process names
 * - Experiment/detector names
 * - Method keywords
 */
export function extractKeyTokens(sentence: string): string[] {
  const tokens: string[] = [];

  // Numbers with units
  const numPattern = /\d+\.?\d*\s*(TeV|GeV|MeV|keV|eV|ab(?:\^-1)?|fb(?:\^-1)?|pb(?:\^-1)?|nb(?:\^-1)?|mb(?:\^-1)?|μb(?:\^-1)?|ub(?:\^-1)?|barn(?:\^-1)?|b|%|σ|sigma)?/gi;
  let match;
  while ((match = numPattern.exec(sentence)) !== null) {
    tokens.push(match[0].toLowerCase().replace(/\s+/g, ''));
  }

  // Particle/process names
  const particlePattern =
    /[HZWB]→[γμτ]+|[Ξ-Ω][a-z]*|X\(\d+\)|Y\(\d+\)|Z[c']?\(\d+\)|P_c?\(\d+\)|T[a-z]*\(\d+\)/gi;
  while ((match = particlePattern.exec(sentence)) !== null) {
    tokens.push(match[0]);
  }

  // Experiment/detector names
  const expPattern =
    /ATLAS|CMS|LHCb|ALICE|Belle|BaBar|BESIII|CERN|LHC|Tevatron|DESY|KEK/gi;
  while ((match = expPattern.exec(sentence)) !== null) {
    tokens.push(match[0].toUpperCase());
  }

  // Method keywords
  const methodPattern =
    /\b(fit|fitting|selection|unfolding|systematic|uncertainty|significance|branching|fraction|ratio|cross.?section|luminosity)\b/gi;
  while ((match = methodPattern.exec(sentence)) !== null) {
    tokens.push(match[0].toLowerCase());
  }

  // Physics concepts
  const conceptPattern =
    /\b(mass|width|lifetime|decay|production|coupling|amplitude|resonance|threshold|pole|molecule|tetraquark|pentaquark|hadronic|charmonium|bottomonium)\b/gi;
  while ((match = conceptPattern.exec(sentence)) !== null) {
    tokens.push(match[0].toLowerCase());
  }

  return [...new Set(tokens)];
}

/**
 * Count words in text (LaTeX-aware)
 */
export function countWords(text: string): number {
  const stripped = stripLatexPreserveHEP(text);
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

/**
 * Calculate Jaccard similarity between two texts
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}
