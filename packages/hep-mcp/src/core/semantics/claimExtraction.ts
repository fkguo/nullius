import { createHash } from 'crypto';
import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_GRADE_EVIDENCE } from '@autoresearch/shared';
import {
  buildClaimExtractionPrompt,
  extractSamplingText,
  parseClaimExtractionResponse,
} from './claimSampling.js';
import { buildToolSamplingMetadata } from '../sampling-metadata.js';
import type { ExtractedClaimV1 } from './claimTypes.js';

export type ClaimSamplingContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

const cache = new Map<string, ExtractedClaimV1[]>();

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function buildCacheKey(
  abstract: string,
  promptVersion: string,
  maxClaims: number,
): string {
  return sha256Hex(JSON.stringify({ abstract, promptVersion, max_claims: maxClaims }));
}

export async function extractClaimsFromAbstract(
  abstract: string,
  ctx: ClaimSamplingContext = {},
  options: { prompt_version?: string; max_claims?: number } = {},
): Promise<ExtractedClaimV1[]> {
  const promptVersion = options.prompt_version ?? 'sem02_claim_extraction_v1';
  const maxClaims = options.max_claims ?? 5;
  if (!abstract.trim()) return [];
  if (!ctx.createMessage) {
    throw new Error('Semantic claim extraction requires MCP client sampling support.');
  }

  const inputHash = sha256Hex(JSON.stringify({ abstract, promptVersion, max_claims: maxClaims }));
  const cacheKey = buildCacheKey(abstract, promptVersion, maxClaims);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await ctx.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: buildClaimExtractionPrompt({ prompt_version: promptVersion, abstract, max_claims: maxClaims }) } }],
      maxTokens: 900,
      metadata: buildToolSamplingMetadata({
        tool: INSPIRE_GRADE_EVIDENCE,
        module: 'sem02_claim_extraction',
        promptVersion,
        costClass: 'high',
      }),
    });
    const parsed = parseClaimExtractionResponse(extractSamplingText(response.content));
    if (!parsed) {
      throw new Error('Semantic claim extraction returned an invalid response.');
    }

    const claims = parsed.map(claim => ({
      ...claim,
      provenance: {
        backend: 'mcp_sampling' as const,
        used_fallback: false,
        prompt_version: promptVersion,
        input_hash: inputHash,
        model: response.model,
      },
      used_fallback: false,
    }));
    cache.set(cacheKey, claims);
    return claims;
  } catch (error) {
    throw new Error(`Semantic claim extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
