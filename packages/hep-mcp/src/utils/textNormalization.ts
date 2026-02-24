// Shared text normalization for search/indexing.
// Goal: keep most text case-insensitive while preserving case-sensitive HEP units
// where capitalization carries physical scale (e.g. meV vs MeV).

const PUA = {
  MEV_MILLI: '\uE200',
  MEV_MEGA: '\uE201',
  KEV: '\uE202',
  GEV: '\uE203',
  TEV: '\uE204',
  EV: '\uE205',

  MEV_C: '\uE210',
  MEV_C2: '\uE211',
  MEV_C2_ALT: '\uE212',
  MEV_C_MILLI: '\uE213',
  MEV_C2_MILLI: '\uE214',
  MEV_C2_MILLI_ALT: '\uE215',

  KEV_C: '\uE220',
  KEV_C2: '\uE221',
  KEV_C2_ALT: '\uE222',

  GEV_C: '\uE230',
  GEV_C2: '\uE231',
  GEV_C2_ALT: '\uE232',

  TEV_C: '\uE240',
  TEV_C2: '\uE241',
  TEV_C2_ALT: '\uE242',
} as const;

type Protection = { re: RegExp; placeholder: string; restore: string };

// All patterns include a prefix capture so we can match units adjacent to digits (e.g. "125MeV")
// without accidentally matching inside longer words (e.g. "SomeMeVLike").
const PROTECTIONS: Protection[] = [
  // Composite units first (avoid partial matches).
  { re: /(^|[^A-Za-z])MeV\/c²(?![A-Za-z])/g, placeholder: PUA.MEV_C2, restore: 'MeV/c²' },
  { re: /(^|[^A-Za-z])MeV\/c\^2(?![A-Za-z])/g, placeholder: PUA.MEV_C2_ALT, restore: 'MeV/c^2' },
  { re: /(^|[^A-Za-z])MeV\/c(?![A-Za-z])/g, placeholder: PUA.MEV_C, restore: 'MeV/c' },

  { re: /(^|[^A-Za-z])meV\/c²(?![A-Za-z])/g, placeholder: PUA.MEV_C2_MILLI, restore: 'meV/c²' },
  { re: /(^|[^A-Za-z])meV\/c\^2(?![A-Za-z])/g, placeholder: PUA.MEV_C2_MILLI_ALT, restore: 'meV/c^2' },
  { re: /(^|[^A-Za-z])meV\/c(?![A-Za-z])/g, placeholder: PUA.MEV_C_MILLI, restore: 'meV/c' },

  { re: /(^|[^A-Za-z])keV\/c²(?![A-Za-z])/g, placeholder: PUA.KEV_C2, restore: 'keV/c²' },
  { re: /(^|[^A-Za-z])keV\/c\^2(?![A-Za-z])/g, placeholder: PUA.KEV_C2_ALT, restore: 'keV/c^2' },
  { re: /(^|[^A-Za-z])keV\/c(?![A-Za-z])/g, placeholder: PUA.KEV_C, restore: 'keV/c' },

  { re: /(^|[^A-Za-z])GeV\/c²(?![A-Za-z])/g, placeholder: PUA.GEV_C2, restore: 'GeV/c²' },
  { re: /(^|[^A-Za-z])GeV\/c\^2(?![A-Za-z])/g, placeholder: PUA.GEV_C2_ALT, restore: 'GeV/c^2' },
  { re: /(^|[^A-Za-z])GeV\/c(?![A-Za-z])/g, placeholder: PUA.GEV_C, restore: 'GeV/c' },

  { re: /(^|[^A-Za-z])TeV\/c²(?![A-Za-z])/g, placeholder: PUA.TEV_C2, restore: 'TeV/c²' },
  { re: /(^|[^A-Za-z])TeV\/c\^2(?![A-Za-z])/g, placeholder: PUA.TEV_C2_ALT, restore: 'TeV/c^2' },
  { re: /(^|[^A-Za-z])TeV\/c(?![A-Za-z])/g, placeholder: PUA.TEV_C, restore: 'TeV/c' },

  // Base units (case sensitive).
  { re: /(^|[^A-Za-z])meV(?![A-Za-z])/g, placeholder: PUA.MEV_MILLI, restore: 'meV' },
  { re: /(^|[^A-Za-z])MeV(?![A-Za-z])/g, placeholder: PUA.MEV_MEGA, restore: 'MeV' },
  { re: /(^|[^A-Za-z])keV(?![A-Za-z])/g, placeholder: PUA.KEV, restore: 'keV' },
  { re: /(^|[^A-Za-z])GeV(?![A-Za-z])/g, placeholder: PUA.GEV, restore: 'GeV' },
  { re: /(^|[^A-Za-z])TeV(?![A-Za-z])/g, placeholder: PUA.TEV, restore: 'TeV' },
  { re: /(^|[^A-Za-z])eV(?![A-Za-z])/g, placeholder: PUA.EV, restore: 'eV' },
];

export function normalizeTextPreserveUnits(text: string): string {
  let out = text;
  for (const p of PROTECTIONS) {
    out = out.replace(p.re, `$1${p.placeholder}`);
  }

  out = out.toLowerCase().replace(/\s+/g, ' ').trim();

  for (const p of PROTECTIONS) {
    out = out.split(p.placeholder).join(p.restore);
  }
  return out;
}

