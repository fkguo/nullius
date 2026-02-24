// ─────────────────────────────────────────────────────────────────────────────
// Author Name Formatting
// ─────────────────────────────────────────────────────────────────────────────

const FAMILY_NAME_PARTICLES = new Set([
  'de', 'del', 'della', 'di', 'du', 'la', 'le', 'van', 'von', 'der', 'den', 'ter',
]);

export function normalizeInitials(name: string): string {
  if (!name) return name;
  return name.replace(/([A-Z])\.([A-Z])/g, '$1. $2');
}

export function buildInitials(given: string): string {
  const normalizedGiven = normalizeInitials(given);
  const words = normalizedGiven.split(/\s+/).filter(Boolean);
  if (!words.length) return '';

  const wordInitials = words
    .map((word) => {
      if (/^[A-Z]\.$/.test(word)) return word;
      const segments = word.split(/-+/).filter(Boolean);
      if (!segments.length) return '';
      const segmentInitials = segments
        .map((segment) => segment.trim()[0])
        .filter((char): char is string => Boolean(char))
        .map((char) => `${char.toUpperCase()}.`);
      return segmentInitials.join('-');
    })
    .filter(Boolean);
  return wordInitials.join(' ');
}

export function formatAuthorName(rawName?: string, keepFullName = true): string {
  if (!rawName) return '';
  const trimmed = rawName.trim();
  if (!trimmed) return '';

  const hasComma = trimmed.includes(',');
  let family = '';
  let given = '';

  if (hasComma) {
    const [familyPart, givenPart] = trimmed.split(',', 2);
    family = (familyPart || '').trim();
    given = (givenPart || '').trim();
  } else {
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) {
      family = parts[0];
    } else {
      let index = parts.length - 1;
      const familyParts = [parts[index]];
      index -= 1;
      while (index >= 0) {
        const candidate = parts[index];
        const lower = candidate.toLowerCase();
        if (FAMILY_NAME_PARTICLES.has(lower)) {
          familyParts.unshift(candidate);
          index -= 1;
        } else {
          break;
        }
      }
      family = familyParts.join(' ');
      given = parts.slice(0, parts.length - familyParts.length).join(' ');
    }
  }

  if (!given) return family || trimmed;
  if (keepFullName) return `${given} ${family}`.trim();

  const initials = buildInitials(given);
  if (!initials) return `${given} ${family}`.trim();
  return `${initials} ${family}`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Author List Formatting
// ─────────────────────────────────────────────────────────────────────────────

const LARGE_COLLABORATION_THRESHOLD = 50;

export function formatAuthors(
  authors: string[],
  options?: { maxAuthors?: number; totalAuthors?: number }
): string {
  if (!authors.length) return 'Unknown Author';

  const hasOthers = authors.some((name) => name.toLowerCase() === 'others');
  const filteredAuthors = authors.filter(
    (name) => name.toLowerCase() !== 'others'
  );
  const formatted = filteredAuthors
    .map((name) => formatAuthorName(name))
    .filter((name): name is string => Boolean(name));

  if (!formatted.length) return 'Unknown Author';

  const maxAuthors = options?.maxAuthors ?? 3;
  const actualTotal = options?.totalAuthors ?? authors.length;

  if (actualTotal > LARGE_COLLABORATION_THRESHOLD) {
    return `${formatted[0]} et al.`;
  }

  if (
    formatted.length > maxAuthors ||
    actualTotal > formatted.length ||
    hasOthers
  ) {
    const displayCount = Math.min(formatted.length, maxAuthors);
    return `${formatted.slice(0, displayCount).join(', ')} et al.`;
  }

  return formatted.join(', ');
}
