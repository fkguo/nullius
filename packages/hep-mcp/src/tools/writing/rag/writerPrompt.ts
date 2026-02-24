/**
 * Writer Prompt Templates
 *
 * Generates structured prompts for LLM writing:
 * - Evidence-based writing instructions
 * - Structured output format
 * - Attribution requirements
 *
 * @module rag/writerPrompt
 */

import type {
  EvidencePacket,
  EvidenceChunk,
  Claim,
  WriterOutput,
  SectionType,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Constants
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = (maxCitations: number) => `You are a physics writing assistant specialized in high-energy physics (HEP).
Your task is to write scientific text based ONLY on the provided evidence.

CRITICAL RULES:
1. ONLY cite evidence with IDs from the allowed list
2. Every factual claim MUST have an evidence ID citation
3. Use [ID] format for citations, e.g., [chunk_abc123]
4. DO NOT invent or hallucinate facts not in the evidence
5. If information is missing, note it in the "gaps" section
6. Maximum ${maxCitations} citations per sentence

OUTPUT FORMAT:
You MUST respond with valid JSON in the following structure:
{
  "plan": [
    {"point": "main point to make", "evidence_ids": ["chunk_id1", "chunk_id2"]}
  ],
  "paragraphs": [
    {
      "intent": "what this paragraph conveys",
      "sentences": [
        {
          "text": "The sentence text [chunk_id1].",
          "kind": "fact|method|result|comparison|meta",
          "evidence_ids": ["chunk_id1"]
        }
      ]
    }
  ],
  "gaps": [
    {"description": "missing information", "suggested_query": "what to search for"}
  ]
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Chunk Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatChunk(chunk: EvidenceChunk, compact: boolean = false): string {
  const parts: string[] = [];

  parts.push(`ID: ${chunk.id}`);
  parts.push(`Type: ${chunk.type}`);

  if (chunk.locator.label) {
    parts.push(`Label: ${chunk.locator.label}`);
  }

  if (chunk.locator.section_path.length > 0) {
    parts.push(`Section: ${chunk.locator.section_path.join(' > ')}`);
  }

  // Content
  const maxLength = compact ? 500 : 2000;
  const content = chunk.text.length > maxLength
    ? chunk.text.slice(0, maxLength) + '...'
    : chunk.text;

  parts.push(`Content:\n${content}`);

  // Semantic description for non-text chunks
  if (chunk.semantic_description) {
    parts.push(`Description: ${chunk.semantic_description}`);
  }

  return parts.join('\n');
}

function formatChunkList(chunks: EvidenceChunk[], compact: boolean = false): string {
  return chunks
    .map((c) => `<evidence>\n${formatChunk(c, compact)}\n</evidence>`)
    .join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim Formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatClaim(claim: Claim): string {
  const parts: string[] = [];

  parts.push(`Claim ID: ${claim.claim_id}`);
  parts.push(`Claim: ${claim.claim_text}`);

  if (claim.supporting_evidence.length > 0) {
    const evidenceList = claim.supporting_evidence
      .map((e) => `${e.chunk_id} (rel: ${e.relevance})`)
      .join(', ');
    parts.push(`Supporting Evidence: ${evidenceList}`);
  }

  return parts.join('\n');
}

function formatClaimList(claims: Claim[]): string {
  return claims
    .map((c) => `<claim>\n${formatClaim(c)}\n</claim>`)
    .join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Type Instructions
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_TYPE_INSTRUCTIONS: Record<SectionType, string> = {
  introduction: `This is an INTRODUCTION section. Focus on:
- Establishing the research context and motivation
- Reviewing relevant prior work with citations
- Stating the main objectives or hypotheses
- Use accessible language while maintaining precision`,

  methodology: `This is a METHODOLOGY section. Focus on:
- Describing the theoretical framework or experimental setup
- Explaining key equations and their significance
- Detailing the analysis procedure
- Use precise technical language with proper notation`,

  results: `This is a RESULTS section. Focus on:
- Presenting quantitative findings with uncertainties
- Referencing tables and figures appropriately
- Comparing with theoretical predictions or prior measurements
- Maintain objectivity; save interpretation for discussion`,

  discussion: `This is a DISCUSSION section. Focus on:
- Interpreting the results in context
- Comparing with other experiments/theories
- Addressing potential limitations or systematic effects
- Discussing implications and future directions`,

  conclusion: `This is a CONCLUSION section. Focus on:
- Summarizing the main findings concisely
- Highlighting the key contributions
- Suggesting future work if relevant
- Keep it brief and impactful`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Prompt Generator
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptOptions {
  /** Use compact chunk format */
  compact?: boolean;
  /** Include context chunks */
  include_context?: boolean;
  /** Target word count */
  target_words?: number;
  /** Style hints */
  style?: 'formal' | 'technical' | 'accessible';
}

/**
 * Generate writer prompt from evidence packet
 */
export function generateWriterPrompt(
  packet: EvidencePacket,
  options: PromptOptions = {}
): { system: string; user: string } {
  const {
    compact = false,
    include_context = true,
    target_words = 500,
    style = 'formal',
  } = options;

  // Build user prompt
  const userParts: string[] = [];

  // Task description
  userParts.push(`## Writing Task\n`);
  userParts.push(`Write the "${packet.task.section_title}" section.`);
  userParts.push(SECTION_TYPE_INSTRUCTIONS[packet.task.section_type]);
  userParts.push(`\nTarget length: approximately ${target_words} words.`);
  userParts.push(`Style: ${style}\n`);

  // Claims to address
  userParts.push(`## Claims to Address\n`);
  userParts.push(`You must address the following claims in this section:\n`);
  userParts.push(formatClaimList(packet.claims));
  userParts.push('');

  // Main evidence
  userParts.push(`## Primary Evidence\n`);
  userParts.push(`Use these evidence chunks to support your writing:\n`);
  userParts.push(formatChunkList(packet.chunks, compact));
  userParts.push('');

  // Context evidence
  if (include_context && packet.context_chunks.length > 0) {
    userParts.push(`## Background Context\n`);
    userParts.push(`Additional context (for background understanding only):\n`);
    userParts.push(formatChunkList(packet.context_chunks, true));
    userParts.push('');
  }

  // Allowed IDs
  userParts.push(`## Allowed Citation IDs\n`);
  userParts.push(`You may ONLY cite these IDs:\n`);
  userParts.push(`Claim IDs: ${packet.allowed.claim_ids.join(', ')}`);
  userParts.push(`Chunk IDs: ${packet.allowed.chunk_ids.join(', ')}`);
  userParts.push('');

  // Reminder
  userParts.push(`## Reminder\n`);
  userParts.push(`- Respond with valid JSON only`);
  userParts.push(`- Every factual statement needs [chunk_id] citation`);
  userParts.push(`- Report missing information in the "gaps" field`);
  userParts.push(`- Max ${packet.budgets.max_citations_per_sentence} citations per sentence`);

  return {
    system: SYSTEM_PROMPT_TEMPLATE(packet.budgets.max_citations_per_sentence),
    user: userParts.join('\n'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse LLM output to WriterOutput
 */
export function parseWriterOutput(output: string): WriterOutput | null {
  try {
    // Extract JSON from markdown code blocks if present
    let jsonStr = output;
    const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    }

    const parsed = JSON.parse(jsonStr.trim());

    // Validate structure
    if (!parsed.plan || !parsed.paragraphs) {
      console.warn('Missing required fields in writer output');
      return null;
    }

    // Ensure gaps array exists
    if (!parsed.gaps) {
      parsed.gaps = [];
    }

    return parsed as WriterOutput;
  } catch (e) {
    console.error('Failed to parse writer output:', e);
    return null;
  }
}

/**
 * Convert WriterOutput to plain text
 */
export function writerOutputToText(output: WriterOutput): string {
  const paragraphs: string[] = [];

  for (const para of output.paragraphs) {
    const sentences = para.sentences.map((s) => s.text).join(' ');
    paragraphs.push(sentences);
  }

  return paragraphs.join('\n\n');
}

/**
 * Extract all evidence IDs from WriterOutput
 */
export function extractEvidenceIds(output: WriterOutput): Set<string> {
  const ids = new Set<string>();

  for (const step of output.plan) {
    for (const id of step.evidence_ids) {
      ids.add(id);
    }
  }

  for (const para of output.paragraphs) {
    for (const sentence of para.sentences) {
      for (const id of sentence.evidence_ids) {
        ids.add(id);
      }
    }
  }

  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

/**
 * Validate writer output against allowed IDs
 */
export function validateWriterOutput(
  output: WriterOutput,
  allowed: { claim_ids: string[]; chunk_ids: string[] }
): ValidationResult {
  const issues: string[] = [];
  const allowedSet = new Set([...allowed.claim_ids, ...allowed.chunk_ids]);

  // Check all cited IDs are allowed
  const usedIds = extractEvidenceIds(output);
  for (const id of usedIds) {
    if (!allowedSet.has(id)) {
      issues.push(`Invalid evidence ID: ${id}`);
    }
  }

  // Check each sentence has citations (for fact/result types)
  for (let pi = 0; pi < output.paragraphs.length; pi++) {
    const para = output.paragraphs[pi];
    for (let si = 0; si < para.sentences.length; si++) {
      const sentence = para.sentences[si];
      if (
        ['fact', 'result'].includes(sentence.kind) &&
        sentence.evidence_ids.length === 0
      ) {
        issues.push(
          `Paragraph ${pi + 1}, Sentence ${si + 1}: ${sentence.kind} sentence has no citation`
        );
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rewrite Prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a rewrite prompt for fixing validation issues
 */
export function generateRewritePrompt(
  originalOutput: WriterOutput,
  issues: string[],
  packet: EvidencePacket
): { system: string; user: string } {
  const userParts: string[] = [];

  userParts.push(`## Rewrite Task\n`);
  userParts.push(`Your previous output had the following issues:`);
  for (const issue of issues) {
    userParts.push(`- ${issue}`);
  }
  userParts.push('');

  userParts.push(`## Previous Output\n`);
  userParts.push('```json');
  userParts.push(JSON.stringify(originalOutput, null, 2));
  userParts.push('```\n');

  userParts.push(`## Instructions\n`);
  userParts.push(`Fix the issues above. Common fixes:`);
  userParts.push(`- Invalid IDs: Use only IDs from the allowed list`);
  userParts.push(`- Missing citations: Add [chunk_id] citations for facts/results`);
  userParts.push(`- Too many citations: Reduce to max ${packet.budgets.max_citations_per_sentence} per sentence`);
  userParts.push('');

  userParts.push(`## Allowed IDs\n`);
  userParts.push(`Chunk IDs: ${packet.allowed.chunk_ids.join(', ')}`);
  userParts.push('');

  userParts.push(`Respond with the corrected JSON only.`);

  return {
    system: SYSTEM_PROMPT_TEMPLATE(packet.budgets.max_citations_per_sentence),
    user: userParts.join('\n'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument Chain Prompt (optional enhancement)
// ─────────────────────────────────────────────────────────────────────────────

const ARGUMENT_CHAIN_SYSTEM = `You are a physics writing assistant specialized in constructing logical argument chains.
Your task is to organize evidence into a coherent logical flow.

OUTPUT FORMAT:
{
  "thesis": "The main claim to argue",
  "steps": [
    {
      "step_id": "s1",
      "claim": "Individual claim in the argument",
      "evidence_ids": ["chunk_id1"],
      "reasoning": "How this follows from the evidence",
      "depends_on": []
    },
    {
      "step_id": "s2",
      "claim": "Next claim",
      "evidence_ids": ["chunk_id2"],
      "reasoning": "How this follows",
      "depends_on": ["s1"]
    }
  ],
  "conclusion": "Final conclusion drawn from the argument chain"
}`;

/**
 * Generate argument chain prompt for complex arguments
 */
export function generateArgumentChainPrompt(
  thesis: string,
  chunks: EvidenceChunk[]
): { system: string; user: string } {
  const userParts: string[] = [];

  userParts.push(`## Thesis\n`);
  userParts.push(thesis);
  userParts.push('');

  userParts.push(`## Available Evidence\n`);
  userParts.push(formatChunkList(chunks, true));
  userParts.push('');

  userParts.push(`Construct a logical argument chain supporting the thesis.`);
  userParts.push(`Each step should cite specific evidence and show clear reasoning.`);
  userParts.push(`Use depends_on to show logical dependencies between steps.`);

  return {
    system: ARGUMENT_CHAIN_SYSTEM,
    user: userParts.join('\n'),
  };
}
