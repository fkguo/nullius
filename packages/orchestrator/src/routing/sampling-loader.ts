import { parseSamplingMetadata, type SamplingMetadata } from '@autoresearch/shared';

import { SamplingRoutingConfigSchema } from './sampling-schema.js';
import type { ResolvedSamplingRoute, SamplingRouteSelectorMatch, SamplingRoutingConfig } from './sampling-types.js';

export const DEFAULT_SAMPLING_MAX_TOKENS = 1024;

function normalizeInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(`Invalid sampling routing config JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function defaultSamplingRoutingConfig(routeKey: string): SamplingRoutingConfig {
  return {
    version: 1,
    default_route: routeKey,
    routes: {
      [routeKey]: {
        backend: 'anthropic',
        model: routeKey,
        max_tokens: DEFAULT_SAMPLING_MAX_TOKENS,
        fallbacks: [],
      },
    },
    selectors: { tools: {}, modules: {}, module_prompt_versions: {}, risk_levels: {}, cost_classes: {} },
  };
}

function validateRouteReferences(config: SamplingRoutingConfig): SamplingRoutingConfig {
  if (!config.routes[config.default_route]) {
    throw new Error(`Sampling routing default_route is unknown: ${config.default_route}`);
  }
  const selectorGroups = [
    ['tool', config.selectors.tools],
    ['module', config.selectors.modules],
    ['module_prompt_version', config.selectors.module_prompt_versions],
    ['risk_level', config.selectors.risk_levels],
    ['cost_class', config.selectors.cost_classes],
  ] as const;
  for (const [kind, selectors] of selectorGroups) {
    for (const [key, routeKey] of Object.entries(selectors)) {
      if (!routeKey) continue;
      if (!config.routes[routeKey]) {
        throw new Error(`Sampling routing ${kind} selector '${key}' points to unknown route '${routeKey}'`);
      }
    }
  }
  for (const [routeKey, route] of Object.entries(config.routes)) {
    for (const fallback of route.fallbacks ?? []) {
      if (!config.routes[fallback]) {
        throw new Error(`Sampling routing route '${routeKey}' points to unknown fallback '${fallback}'`);
      }
    }
  }
  return config;
}

function dedupeRouteKeys(routeKeys: string[]): string[] {
  return [...new Set(routeKeys)];
}

export function loadSamplingRoutingConfig(input: unknown, defaultRouteKey: string): SamplingRoutingConfig {
  const normalized = normalizeInput(input);
  if (normalized === undefined || normalized === null) {
    return defaultSamplingRoutingConfig(defaultRouteKey);
  }
  const parsed = SamplingRoutingConfigSchema.parse(normalized);
  return validateRouteReferences({
    version: parsed.version,
    default_route: parsed.default_route,
    routes: parsed.routes,
    selectors: parsed.selectors,
  });
}

export function resolveSamplingRoute(config: SamplingRoutingConfig, metadataInput: SamplingMetadata | unknown): ResolvedSamplingRoute {
  const metadata = parseSamplingMetadata(metadataInput);
  const modulePromptVersionKey = `${metadata.module}@${metadata.prompt_version}`;
  const matches: Array<[SamplingRouteSelectorMatch['kind'], string, string | undefined]> = [
    ['module_prompt_version', modulePromptVersionKey, config.selectors.module_prompt_versions[modulePromptVersionKey]],
    ['module', metadata.module, config.selectors.modules[metadata.module]],
    ['tool', metadata.tool, config.selectors.tools[metadata.tool]],
    ['risk_level', metadata.risk_level, config.selectors.risk_levels[metadata.risk_level]],
    ['cost_class', metadata.cost_class, config.selectors.cost_classes[metadata.cost_class]],
  ];
  const match = matches.find(([, , routeKey]) => Boolean(routeKey));
  const routeKey = match?.[2] ?? config.default_route;
  const route = config.routes[routeKey];
  if (!route) {
    throw new Error(`Unknown sampling route key: ${routeKey}`);
  }
  const selector: SamplingRouteSelectorMatch = match
    ? { kind: match[0], key: match[1] }
    : { kind: 'default', key: config.default_route };
  return {
    ...route,
    route_key: routeKey,
    selector,
    attempt_route_keys: dedupeRouteKeys([routeKey, ...(route.fallbacks ?? [])]),
    metadata,
  };
}
