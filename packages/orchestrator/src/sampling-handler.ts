import { parseSamplingMetadata } from '@autoresearch/shared';

import type { LedgerWriter } from './ledger-writer.js';
import { createChatBackend, type ChatBackendFactory } from './backends/backend-factory.js';
import type { MessageContent, MessageParam } from './backends/chat-backend.js';
import { DEFAULT_SAMPLING_MAX_TOKENS, resolveSamplingRoute } from './routing/sampling-loader.js';
import type { ResolvedSamplingRoute, SamplingRoutingConfig } from './routing/sampling-types.js';

export type SamplingTextPart = { type: 'text'; text: string };
export type SamplingRequestMessage = {
  role: 'user' | 'assistant';
  content: string | SamplingTextPart | SamplingTextPart[];
};

export interface HostSamplingRequest {
  messages: SamplingRequestMessage[];
  maxTokens?: number;
  metadata: unknown;
}

export interface SamplingAttemptAudit {
  route_key: string;
  backend: string;
  model: string;
  success: boolean;
  error?: string;
}

export interface SamplingExecutionAudit {
  metadata: ReturnType<typeof parseSamplingMetadata>;
  route: ResolvedSamplingRoute;
  attempts: SamplingAttemptAudit[];
}

export interface SamplingExecutionResult {
  result: {
    model: string;
    role: 'assistant';
    content: MessageContent[];
    stopReason?: string;
  };
  audit: SamplingExecutionAudit;
}

function logEvent(ledger: LedgerWriter | undefined, eventType: string, details: Record<string, unknown>): void {
  ledger?.log(eventType, { details });
}

function toTextContent(content: SamplingRequestMessage['content']): string | SamplingTextPart[] {
  if (typeof content === 'string') return content;
  const items = Array.isArray(content) ? content : [content];
  return items.map(item => {
    if (item.type !== 'text' || typeof item.text !== 'string') {
      throw new Error('Sampling request content must be text-only');
    }
    return { type: 'text', text: item.text };
  });
}

function toMessageParams(messages: SamplingRequestMessage[]): MessageParam[] {
  return messages.map(message => ({ role: message.role, content: toTextContent(message.content) }));
}

function toChatRoute(route: ResolvedSamplingRoute) {
  return {
    backend: route.backend,
    model: route.model,
    max_tokens: route.max_tokens,
    route_key: route.route_key,
    requested_key: route.route_key,
  };
}

function routeForAttempt(config: SamplingRoutingConfig, route: ResolvedSamplingRoute, routeKey: string): ResolvedSamplingRoute {
  const definition = config.routes[routeKey];
  if (!definition) {
    throw new Error(`Unknown sampling route key: ${routeKey}`);
  }
  return {
    ...definition,
    route_key: routeKey,
    selector: route.selector,
    attempt_route_keys: route.attempt_route_keys,
    metadata: route.metadata,
  };
}

export async function executeSamplingRequest(params: {
  request: HostSamplingRequest;
  routingConfig: SamplingRoutingConfig;
  backendFactory?: ChatBackendFactory;
  ledger?: LedgerWriter;
}): Promise<SamplingExecutionResult> {
  const metadata = parseSamplingMetadata(params.request.metadata);
  const route = resolveSamplingRoute(params.routingConfig, metadata);
  const messages = toMessageParams(params.request.messages);
  const audit: SamplingExecutionAudit = { metadata, route, attempts: [] };
  logEvent(params.ledger, 'mcp_client.sampling_route_resolved', {
    metadata,
    route_key: route.route_key,
    selector: route.selector,
    fallback_chain: route.attempt_route_keys,
  });

  for (const routeKey of route.attempt_route_keys) {
    const attemptRoute = routeForAttempt(params.routingConfig, route, routeKey);
    const backend = (params.backendFactory ?? createChatBackend)(toChatRoute(attemptRoute));
    try {
      const response = await backend.createMessage({
        model: attemptRoute.model,
        maxTokens: params.request.maxTokens ?? attemptRoute.max_tokens ?? DEFAULT_SAMPLING_MAX_TOKENS,
        messages,
        tools: [],
      });
      audit.attempts.push({
        route_key: routeKey,
        backend: attemptRoute.backend,
        model: attemptRoute.model,
        success: true,
      });
      logEvent(params.ledger, 'mcp_client.sampling_completed', {
        route_key: routeKey,
        backend: attemptRoute.backend,
        model: attemptRoute.model,
        attempts: audit.attempts,
      });
      return {
        result: {
          model: attemptRoute.model,
          role: 'assistant',
          content: response.content,
          stopReason: response.stop_reason,
        },
        audit,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      audit.attempts.push({
        route_key: routeKey,
        backend: attemptRoute.backend,
        model: attemptRoute.model,
        success: false,
        error: message,
      });
      logEvent(params.ledger, 'mcp_client.sampling_attempt_failed', {
        route_key: routeKey,
        backend: attemptRoute.backend,
        model: attemptRoute.model,
        error: message,
      });
    }
  }

  const failReason = `Sampling request failed after ${audit.attempts.length} attempt(s)`;
  logEvent(params.ledger, 'mcp_client.sampling_failed', {
    reason: failReason,
    attempts: audit.attempts,
    metadata,
  });
  throw new Error(failReason);
}
