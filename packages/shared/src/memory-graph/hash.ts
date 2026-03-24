const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

const FILE_PATH_RE = /(?:[A-Za-z]:)?(?:\.{0,2}\/|~\/|\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]+(?::\d+)?/g;
const NUMBER_RE = /\b\d+\b/g;

function fnv1aHash(value: string): string {
  let hash = FNV_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeSignal(signal: string): string {
  return signal
    .replace(FILE_PATH_RE, '<path>')
    .replace(NUMBER_RE, '<N>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeSignals(signals: string[]): string[] {
  return [...new Set(signals.map(normalizeSignal).filter(Boolean))].sort();
}

export function computeSignalKey(signals: string[]): string {
  return fnv1aHash(normalizeSignals(signals).join('|'));
}
