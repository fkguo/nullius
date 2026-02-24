/**
 * LLM Configuration from Environment Variables
 */

import type { LLMCallMode, LLMConfig, LLMProvider, WritingModeConfig } from '../types.js';
import { DEFAULT_BASE_URLS } from './types.js';

const VALID_MODES: LLMCallMode[] = ['passthrough', 'client', 'internal'];
const VALID_PROVIDERS: LLMProvider[] = [
  'openai', 'anthropic', 'google', 'deepseek', 'kimi', 'glm', 'qwen', 'openai-compatible'
];

/** Read LLM config from environment variables */
export function getLLMConfigFromEnv(): LLMConfig | undefined {
  const provider = process.env.WRITING_LLM_PROVIDER as LLMProvider | undefined;
  const apiKey = process.env.WRITING_LLM_API_KEY;
  const model = process.env.WRITING_LLM_MODEL;

  if (!provider || !apiKey) {
    return undefined;
  }

  if (!VALID_PROVIDERS.includes(provider)) {
    console.warn(`Invalid WRITING_LLM_PROVIDER: ${provider}`);
    return undefined;
  }

  const baseUrl = process.env.WRITING_LLM_BASE_URL || DEFAULT_BASE_URLS[provider];
  const temperature = process.env.WRITING_LLM_TEMPERATURE
    ? parseFloat(process.env.WRITING_LLM_TEMPERATURE)
    : 0.3;
  const maxTokens = process.env.WRITING_LLM_MAX_TOKENS
    ? parseInt(process.env.WRITING_LLM_MAX_TOKENS, 10)
    : undefined;

  return {
    provider,
    model: model || getDefaultModel(provider),
    apiKey,
    baseUrl,
    temperature,
    maxTokens,
  };
}

/** Get default model for provider */
function getDefaultModel(provider: LLMProvider): string {
  const defaults: Record<LLMProvider, string> = {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-20250514',
    google: 'gemini-1.5-pro',
    deepseek: 'deepseek-chat',
    kimi: 'moonshot-v1-128k',
    glm: 'glm-4-plus',
    qwen: 'qwen-max',
    'openai-compatible': 'gpt-4o',
  };
  return defaults[provider];
}

/** Resolve effective LLM mode */
export function resolveEffectiveMode(toolParam?: LLMCallMode): LLMCallMode {
  // 1. Tool parameter has highest priority
  if (toolParam && VALID_MODES.includes(toolParam)) {
    return toolParam;
  }

  // 2. Environment variable
  const envMode = process.env.WRITING_LLM_MODE as LLMCallMode | undefined;
  if (envMode && VALID_MODES.includes(envMode)) {
    return envMode;
  }

  // 3. Smart default: internal if config is complete, otherwise client
  const config = getLLMConfigFromEnv();
  if (config) {
    return 'internal';
  }

  return 'client';
}

/** Get full writing mode config */
export function getWritingModeConfig(toolParam?: LLMCallMode): WritingModeConfig {
  const mode = resolveEffectiveMode(toolParam);
  const llmConfig = mode === 'internal' ? getLLMConfigFromEnv() : undefined;

  const timeout = process.env.WRITING_LLM_TIMEOUT
    ? parseInt(process.env.WRITING_LLM_TIMEOUT, 10)
    : 90000;
  const maxRetries = process.env.WRITING_LLM_MAX_RETRIES
    ? parseInt(process.env.WRITING_LLM_MAX_RETRIES, 10)
    : 3;

  return {
    mode,
    llmConfig,
    timeout,
    maxRetries,
  };
}
