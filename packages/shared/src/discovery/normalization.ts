export function normalizeDiscoveryQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ');
}

export function normalizeDiscoveryTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDiscoveryName(name: string): string {
  return normalizeDiscoveryTitle(name);
}
