const CHAR_MAP: Record<string, string> = {
  // Greek letters commonly used in particle names
  π: 'pi',
  Π: 'pi',
  μ: 'mu',
  Μ: 'mu',
  τ: 'tau',
  Τ: 'tau',
  ν: 'nu',
  Ν: 'nu',
  γ: 'gamma',
  Γ: 'gamma',
  η: 'eta',
  Η: 'eta',
  ρ: 'rho',
  Ρ: 'rho',
  λ: 'lambda',
  Λ: 'lambda',
  φ: 'phi',
  Φ: 'phi',
  χ: 'chi',
  Χ: 'chi',
  ω: 'omega',
  Ω: 'omega',

  // Common sign variants
  '−': '-',
  '–': '-',
  '—': '-',
  '±': '+-',

  // Superscripts
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',

  // Subscripts
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',
  '₆': '6',
  '₇': '7',
  '₈': '8',
  '₉': '9',
  '₊': '+',
  '₋': '-',
};

const CHAR_REGEX = new RegExp(`[${Object.keys(CHAR_MAP).join('')}]`, 'g');

export function normalizeParticleNameInput(name: string): { normalized: string; changed: boolean } {
  const original = name;
  const normalized = original
    .normalize('NFKC')
    .replaceAll(CHAR_REGEX, m => CHAR_MAP[m] ?? m)
    .trim();

  return { normalized, changed: normalized !== original };
}

