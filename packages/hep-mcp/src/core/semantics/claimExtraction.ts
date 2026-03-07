import { createHash } from 'crypto';
import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_CRITICAL_RESEARCH } from '@autoresearch/shared';
import {
  buildClaimExtractionPrompt,
  extractSamplingText,
  parseClaimExtractionResponse,
} from './claimSampling.js';
import { determineEvidenceLevel, extractSigmaLevel, heuristicExtractClaimCandidates } from './citationStanceHeuristics.js';
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
  mode: 'heuristic' | 'mcp_sampling',
): string {
  return sha256Hex(JSON.stringify({ abstract, promptVersion, max_claims: maxClaims, mode }));
}

function toFallbackClaims(
  abstract: string,
  promptVersion: string,
  inputHash: string,
  maxClaims: number,
): ExtractedClaimV1[] {
  return heuristicExtractClaimCandidates(abstract, maxClaims).map((claim, index) => {
    const sigmaLevel = extractSigmaLevel(claim.text);
    return {
      claim_id: `c${index + 1}`,
      claim_text: claim.text,
      source_context: { before: claim.before, after: claim.after },
      evidence_level: determineEvidenceLevel(claim.text, sigmaLevel),
      sigma_level: sigmaLevel,
      provenance: {
        backend: 'heuristic',
        used_fallback: true,
        prompt_version: promptVersion,
        input_hash: inputHash,
      },
      used_fallback: true,
    };
  });
}

export async function extractClaimsFromAbstract(
  abstract: string,
  ctx: ClaimSamplingContext = {},
  options: { prompt_version?: string; max_claims?: number } = {},
): Promise<ExtractedClaimV1[]> {
  const promptVersion = options.prompt_version ?? 'sem02_claim_extraction_v1';
  const maxClaims = options.max_claims ?? 5;
  if (!abstract.trim()) return [];

  const inputHash = sha256Hex(JSON.stringify({ abstract, promptVersion, max_claims: maxClaims }));
  // Keep heuristic and MCP-sampling results in separate cache namespaces so a
  // temporary fallback result never masks a later semantic extraction pass.
  const cacheKey = buildCacheKey(abstract, promptVersion, maxClaims, ctx.createMessage ? 'mcp_sampling' : 'heuristic');
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (!ctx.createMessage) {
    const fallback = toFallbackClaims(abstract, promptVersion, inputHash, maxClaims);
    cache.set(cacheKey, fallback);
    return fallback;
  }

  try {
    const response = await ctx.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: buildClaimExtractionPrompt({ prompt_version: promptVersion, abstract, max_claims: maxClaims }) } }],
      maxTokens: 900,
      metadata: buildToolSamplingMetadata({
        tool: INSPIRE_CRITICAL_RESEARCH,
        module: 'sem02_claim_extraction',
        promptVersion,
        costClass: 'low',
      }),
    });
    const parsed = parseClaimExtractionResponse(extractSamplingText(response.content));
    if (!parsed || parsed.length === 0) {
      // Do not cache this fallback under the MCP-sampling key: an empty/invalid
      // model response can be transient, and future calls should still retry sampling.
      return toFallbackClaims(abstract, promptVersion, inputHash, maxClaims);
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
  } catch {
    return toFallbackClaims(abstract, promptVersion, inputHash, maxClaims);
  }
}
