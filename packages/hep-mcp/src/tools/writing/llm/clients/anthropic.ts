/**
 * Anthropic LLM Client
 */

import type { LLMConfig, LLMProvider } from '../../types.js';
import type { LLMClient, LLMResponse } from '../types.js';
import { RateLimitError, AuthenticationError } from './openai.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: 'text'; text: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicClient implements LLMClient {
  readonly provider: LLMProvider = 'anthropic';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeout: number;

  constructor(config: LLMConfig, timeout = 90000) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.temperature = config.temperature ?? 0.3;
    this.maxTokens = config.maxTokens || 8192;
    this.timeout = timeout;
  }

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const response = await this.generateWithMetadata(prompt, systemPrompt);
    return response.content;
  }

  async generateWithMetadata(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    const startTime = Date.now();
    const messages: AnthropicMessage[] = [{ role: 'user', content: prompt }];

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();

        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          throw new RateLimitError(
            `Rate limited: ${errorText}`,
            retryAfter ? parseInt(retryAfter, 10) : undefined
          );
        }

        if (response.status === 401 || response.status === 403) {
          throw new AuthenticationError(`Authentication failed: ${errorText}`);
        }

        throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as AnthropicResponse;
      const content = data.content[0]?.text || '';

      return {
        content,
        usage: {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.input_tokens + data.usage.output_tokens,
        },
        latency_ms: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
