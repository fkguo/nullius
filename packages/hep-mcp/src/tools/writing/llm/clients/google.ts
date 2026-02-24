/**
 * Google Gemini LLM Client
 */

import type { LLMConfig, LLMProvider } from '../../types.js';
import type { LLMClient, LLMResponse } from '../types.js';

interface GeminiContent {
  parts: Array<{ text: string }>;
  role?: 'user' | 'model';
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export class GoogleClient implements LLMClient {
  readonly provider: LLMProvider = 'google';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly maxTokens?: number;
  private readonly timeout: number;

  constructor(config: LLMConfig, timeout = 90000) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
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
    const contents: GeminiContent[] = [];

    if (systemPrompt) {
      contents.push({ parts: [{ text: systemPrompt }], role: 'user' });
      contents.push({ parts: [{ text: 'Understood.' }], role: 'model' });
    }
    contents.push({ parts: [{ text: prompt }], role: 'user' });

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: this.temperature,
        ...(this.maxTokens && { maxOutputTokens: this.maxTokens }),
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google API error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as GeminiResponse;
      const content = data.candidates[0]?.content?.parts[0]?.text || '';

      return {
        content,
        usage: data.usageMetadata ? {
          prompt_tokens: data.usageMetadata.promptTokenCount,
          completion_tokens: data.usageMetadata.candidatesTokenCount,
          total_tokens: data.usageMetadata.totalTokenCount,
        } : undefined,
        latency_ms: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
