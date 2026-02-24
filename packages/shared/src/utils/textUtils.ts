// ─────────────────────────────────────────────────────────────────────────────
// Text Normalization Constants
// ─────────────────────────────────────────────────────────────────────────────

const SPECIAL_CHAR_REPLACEMENTS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
};

const SPECIAL_CHAR_REGEX = /[ßæœøđðþł]/g;

const GERMAN_UMLAUT_REPLACEMENTS: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
};

const GERMAN_UMLAUT_REGEX = /[äöü]/g;
const COMBINING_MARKS_REGEX = /[\u0300-\u036f]/g;

// ─────────────────────────────────────────────────────────────────────────────
// Text Normalization Functions
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeSearchText(value: string): string {
  if (!value) return '';
  const lower = value.toLowerCase();
  const replaced = lower.replace(
    SPECIAL_CHAR_REGEX,
    (char) => SPECIAL_CHAR_REPLACEMENTS[char] ?? char
  );
  return replaced.normalize('NFD').replace(COMBINING_MARKS_REGEX, '');
}

export function buildVariantSet(value: string): string[] {
  if (!value) return [];
  const normalized = normalizeSearchText(value);
  const umlautExpanded = normalizeSearchText(
    value
      .toLowerCase()
      .replace(
        GERMAN_UMLAUT_REGEX,
        (char) => GERMAN_UMLAUT_REPLACEMENTS[char] ?? char
      )
  );
  const variants = [normalized, umlautExpanded].filter(Boolean);
  return Array.from(new Set(variants));
}

export function buildSearchIndexText(value: string): string {
  return buildVariantSet(value).join(' ');
}
