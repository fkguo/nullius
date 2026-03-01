/**
 * LaTeX text stripping utilities for HEP content.
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
