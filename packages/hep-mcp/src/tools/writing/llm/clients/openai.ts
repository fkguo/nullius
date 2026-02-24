/**
 * OpenAI-Compatible LLM Client
 * Supports: OpenAI, DeepSeek, Kimi, GLM, Qwen
 */

import type { LLMConfig, LLMProvider } from '../../types.js';
import type { LLMClient, LLMResponse } from '../types.js';
import { DEFAULT_BASE_URLS } from '../types.js';

/** Custom error for rate limiting */
export class RateLimitError extends Error {
  constructor(message: string, public retryAfter?: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/** Custom error for authentication */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
      /** Reasoning content from reasoning models (e.g., DeepSeek R1) */
      reasoning_content?: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAICompatibleClient implements LLMClient {
  readonly provider: LLMProvider;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly maxTokens?: number;
  private readonly timeout: number;

  constructor(config: LLMConfig, timeout = 90000) {
    this.provider = config.provider;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URLS[config.provider];
    this.temperature = config.temperature ?? 0.3;
    this.maxTokens = config.maxTokens;
    this.timeout = timeout;
  }

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const response = await this.generateWithMetadata(prompt, systemPrompt);
    return response.content;
  }

  async generateWithMetadata(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    const startTime = Date.now();
    const messages: OpenAIMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: this.temperature,
    };

    if (this.maxTokens) {
      body.max_tokens = this.maxTokens;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();

        // Handle specific error codes
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

        throw new Error(`LLM API error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as OpenAIResponse;
      const message = data.choices[0]?.message;
      const content = message?.content || '';
      const reasoning_content = message?.reasoning_content;

      return {
        content,
        reasoning_content,
        usage: data.usage,
        latency_ms: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
