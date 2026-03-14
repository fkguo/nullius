import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { schemaValidationError } from './errors.js';

const MAX_INITIAL_ISLAND_COUNT = 20;
const HEP_BUILTIN_PACK_CATALOG = resolve(
  fileURLToPath(new URL('../../../idea-core/src/idea_core/engine/hep_builtin_domain_packs.json', import.meta.url)),
);

interface DomainPackEntry {
  pack_id: string;
  domain_prefixes: string[];
}

interface DomainPackResolution {
  abstractProblemRegistry: Record<string, unknown>;
  enabledPackIds: string[];
  packId: string;
}

function extensionStringList(extensions: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = extensions[key];
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
    if (!Array.isArray(value)) {
      continue;
    }
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (typeof item !== 'string') {
        continue;
      }
      const compact = item.trim();
      if (!compact || seen.has(compact)) {
        continue;
      }
      seen.add(compact);
      resolved.push(compact);
    }
    return resolved;
  }
  return [];
}

function builtinDomainPacks(): DomainPackEntry[] {
  const payload = JSON.parse(readFileSync(HEP_BUILTIN_PACK_CATALOG, 'utf8')) as { packs?: DomainPackEntry[] };
  return payload.packs ?? [];
}

export function mergeRegistryEntries(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
  keyName: string,
): Record<string, unknown> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const entry of (defaults.entries as Record<string, unknown>[] | undefined) ?? []) {
    merged.set(String(entry[keyName]), structuredClone(entry));
  }
  for (const entry of (overrides?.entries as Record<string, unknown>[] | undefined) ?? []) {
    merged.set(String(entry[keyName]), structuredClone(entry));
  }
  return { entries: [...merged.values()] };
}

export function resolveInitialIslandCount(charter: Record<string, unknown>): number {
  const extensions = typeof charter.extensions === 'object' && charter.extensions && !Array.isArray(charter.extensions)
    ? charter.extensions as Record<string, unknown>
    : {};
  let raw: unknown;
  for (const key of ['initial_island_count', 'island_count']) {
    if (key in extensions) {
      raw = extensions[key];
      break;
    }
  }
  if (raw === undefined) {
    return 1;
  }
  let count: number;
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    count = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    count = Number.parseInt(raw.trim(), 10);
  } else {
    throw schemaValidationError('initial_island_count must be an integer >= 1');
  }
  if (count < 1) {
    throw schemaValidationError('initial_island_count must be an integer >= 1');
  }
  if (count > MAX_INITIAL_ISLAND_COUNT) {
    throw schemaValidationError(`initial_island_count must be <= ${MAX_INITIAL_ISLAND_COUNT}`);
  }
  return count;
}

export function initialIslandStates(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    island_id: `island-${index}`,
    state: 'SEEDING',
    population_size: 0,
    stagnation_counter: 0,
    repopulation_count: 0,
    best_score: null,
  }));
}

export function resolveDomainPackForCharter(charter: Record<string, unknown>): DomainPackResolution {
  const extensions = typeof charter.extensions === 'object' && charter.extensions && !Array.isArray(charter.extensions)
    ? charter.extensions as Record<string, unknown>
    : {};
  const descriptors = builtinDomainPacks();
  const descriptorIds = new Set(descriptors.map(entry => entry.pack_id));
  const enabledPackIds = extensionStringList(extensions, ['enable_domain_packs', 'enabled_domain_packs']);
  const disabledPackIds = new Set(extensionStringList(extensions, ['disable_domain_packs', 'disabled_domain_packs']));
  const requestedPackId = ['domain_pack_id', 'active_domain_pack_id']
    .map(key => extensions[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

  let candidatePackIds = enabledPackIds;
  if (candidatePackIds.length > 0) {
    const unknownEnabled = candidatePackIds.filter(packId => !descriptorIds.has(packId));
    if (unknownEnabled.length > 0) {
      throw schemaValidationError(`unknown enabled domain pack id(s): ${unknownEnabled.join(', ')}`);
    }
  } else {
    const domain = typeof charter.domain === 'string' ? charter.domain.trim() : '';
    candidatePackIds = descriptors
      .filter(entry => entry.domain_prefixes.length === 0 || entry.domain_prefixes.some(prefix => domain.startsWith(prefix)))
      .map(entry => entry.pack_id);
    if (candidatePackIds.length === 0) {
      throw schemaValidationError(`no domain pack available for domain: ${domain || '<empty>'}`);
    }
  }

  candidatePackIds = candidatePackIds.filter(packId => !disabledPackIds.has(packId));
  if (candidatePackIds.length === 0) {
    throw schemaValidationError('domain pack candidates are empty after enable/disable filters');
  }

  if (requestedPackId && !descriptorIds.has(requestedPackId)) {
    throw schemaValidationError(`unknown domain_pack_id: ${requestedPackId}`);
  }
  if (requestedPackId && !candidatePackIds.includes(requestedPackId)) {
    throw schemaValidationError(`requested domain_pack_id not enabled: ${requestedPackId}`);
  }

  return {
    packId: requestedPackId ?? candidatePackIds[0]!,
    enabledPackIds: candidatePackIds,
    abstractProblemRegistry: {
      entries: [
        {
          abstract_problem_type: 'optimization',
          description: 'Default optimization abstraction for provider-local packs.',
          known_solution_families: ['gradient-based'],
          prerequisite_checklist: ['objective is defined'],
          reference_uris: ['https://example.org/optimization'],
        },
      ],
    },
  };
}
