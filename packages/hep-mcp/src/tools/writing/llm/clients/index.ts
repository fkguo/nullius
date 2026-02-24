/**
 * LLM Clients Index
 */

import type { LLMConfig } from '../../types.js';
import type { LLMClient } from '../types.js';
import { OPENAI_COMPATIBLE_PROVIDERS } from '../types.js';
import { OpenAICompatibleClient } from './openai.js';
import { AnthropicClient } from './anthropic.js';
import { GoogleClient } from './google.js';

export { OpenAICompatibleClient, RateLimitError, AuthenticationError } from './openai.js';
export { AnthropicClient } from './anthropic.js';
export { GoogleClient } from './google.js';

/** Create LLM client from config */
export function createLLMClient(config: LLMConfig, timeout?: number): LLMClient {
  if (config.provider === 'anthropic') {
    return new AnthropicClient(config, timeout);
  }

  if (config.provider === 'google') {
    return new GoogleClient(config, timeout);
  }

  if (OPENAI_COMPATIBLE_PROVIDERS.includes(config.provider)) {
    return new OpenAICompatibleClient(config, timeout);
  }

  throw new Error(`Unsupported LLM provider: ${config.provider}`);
}
