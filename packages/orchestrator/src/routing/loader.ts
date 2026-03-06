import { ChatRoutingConfigSchema } from './schema.js';
import type { ChatRoutingConfig, ResolvedChatRoute } from './types.js';

export const DEFAULT_CHAT_MAX_TOKENS = 8192;

function normalizeInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(`Invalid routing config JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function defaultRoutingConfig(routeKey: string): ChatRoutingConfig {
  return {
    version: 1,
    default_route: routeKey,
    routes: {
      [routeKey]: {
        backend: 'anthropic',
        model: routeKey,
        max_tokens: DEFAULT_CHAT_MAX_TOKENS,
      },
    },
    use_cases: {},
  };
}

function validateRouteReferences(config: ChatRoutingConfig): ChatRoutingConfig {
  if (!config.routes[config.default_route]) {
    throw new Error(`Routing config default_route is unknown: ${config.default_route}`);
  }
  for (const [useCase, routeKey] of Object.entries(config.use_cases)) {
    if (!config.routes[routeKey]) {
      throw new Error(`Routing config use_case '${useCase}' points to unknown route '${routeKey}'`);
    }
  }
  return config;
}

export function loadRoutingConfig(input: unknown, defaultRouteKey: string): ChatRoutingConfig {
  const normalized = normalizeInput(input);
  if (normalized === undefined || normalized === null) {
    return defaultRoutingConfig(defaultRouteKey);
  }
  const parsed = ChatRoutingConfigSchema.parse(normalized);
  return validateRouteReferences({
    version: parsed.version,
    default_route: parsed.default_route,
    routes: parsed.routes,
    use_cases: parsed.use_cases,
  });
}

export function resolveChatRoute(config: ChatRoutingConfig, requestedKey: string): ResolvedChatRoute {
  const normalizedKey = requestedKey.trim();
  const directRoute = config.routes[normalizedKey];
  const aliasedRouteKey = config.use_cases[normalizedKey];
  const routeKey = directRoute ? normalizedKey : aliasedRouteKey ?? config.default_route;

  const route = config.routes[routeKey];
  if (!route) {
    throw new Error(`Unknown route key: ${normalizedKey}`);
  }

  if (!directRoute && !aliasedRouteKey && normalizedKey && normalizedKey !== config.default_route) {
    throw new Error(`Unknown route key: ${normalizedKey}`);
  }

  return {
    ...route,
    route_key: routeKey,
    requested_key: normalizedKey,
  };
}
