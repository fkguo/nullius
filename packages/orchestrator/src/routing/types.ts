export type ChatBackendName = 'anthropic';

export interface ChatRouteDefinition {
  backend: ChatBackendName;
  model: string;
  max_tokens?: number;
}

export interface ChatRoutingConfig {
  version: 1;
  default_route: string;
  routes: Record<string, ChatRouteDefinition>;
  use_cases: Record<string, string>;
}

export interface ResolvedChatRoute extends ChatRouteDefinition {
  route_key: string;
  requested_key: string;
}
