/**
 * LLM Client Types for Internal Mode
 */

import type { LLMProvider, LLMConfig } from '../types.js';

/** LLM Client interface */
export interface LLMClient {
  generate(prompt: string, systemPrompt?: string): Promise<string>;
  /** Generate with full response including reasoning_content */
  generateWithMetadata?(prompt: string, systemPrompt?: string): Promise<LLMResponse>;
  readonly provider: LLMProvider;
  readonly model: string;
}

/** LLM response with metadata */
export interface LLMResponse {
  content: string;
  /** Reasoning content from reasoning models (e.g., DeepSeek R1) */
  reasoning_content?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  latency_ms: number;
}

/** Audit info for LLM calls */
export interface LLMAuditInfo {
  provider: LLMProvider;
  model: string;
  attempts: number;
  total_latency_ms: number;
  success: boolean;
  error?: string;
}

/** Default base URLs for providers */
export const DEFAULT_BASE_URLS: Record<LLMProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
  kimi: 'https://api.moonshot.cn/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'openai-compatible': '',
};

/** Providers that use OpenAI-compatible API */
export const OPENAI_COMPATIBLE_PROVIDERS: LLMProvider[] = [
  'openai',
  'deepseek',
  'kimi',
  'glm',
  'qwen',
  'openai-compatible',
];

export type { LLMProvider, LLMConfig };
