/**
 * Shared Prompt Templates for Writing Tools
 *
 * Used by both client mode (Host LLM) and internal mode (configured LLM).
 * The only difference between modes is which LLM processes the prompt.
 */

import type { WritingPacket } from '../types.js';
import { isSoftDepthConfig } from '../types.js';
import { buildAssignedAssetsBlock } from './assetInjection.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants for token optimization
// ─────────────────────────────────────────────────────────────────────────────

/** Max chars for source_context in prompt (claims are NOT truncated to preserve quality) */
const MAX_CONTEXT_CHARS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt (shared between client and internal modes)
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT_EN = `You are an expert academic writer specializing in high-energy physics review articles.
Your task is to write a section of a review paper based on the provided claims and evidence.

## Anti-Hallucination (CRITICAL!)
1. **ONLY use content from claim_text and source_context provided below**
2. **Do NOT add inferences, conclusions, or facts not in the original claims**
3. Use hedging language ("may", "possibly", "suggests") when interpreting
4. Every factual statement must be traceable to a specific claim
5. If a claim has is_abstract_fallback=true, it contains the full abstract - use it as context

## Writing Rules
1. **CITATION CONSTRAINT (HARD RULE - WILL FAIL IF VIOLATED!):**
   - You may ONLY cite papers from the allowed_citations list below
   - Citing ANY paper NOT in allowed_citations = IMMEDIATE REJECTION
   - The verification system WILL detect and reject unauthorized citations
   - If unsure about a citation, DO NOT include it
2. Every factual statement MUST have a citation using \\cite{inspire:recid} format
3. Write in formal academic prose, NO bullet points or numbered lists
4. Each paragraph should synthesize information from MULTIPLE papers
5. Discuss figures and equations substantively, not just mention them
6. Use \\cite{key} for citations, \\ref{label} for figures/equations
7. Each paragraph must have at least 4 sentences - no single-sentence paragraphs

## cite_only Papers
For papers marked as cite_only (no claims available):
- Do NOT discuss their specific content
- Only reference them at paragraph end: "See also Refs.~\\cite{xxx}."
- Do NOT fabricate content for these papers

OUTPUT FORMAT:
Return the section content as LaTeX.`;

// ─────────────────────────────────────────────────────────────────────────────
// Depth Rules (compressed for token optimization)
// ─────────────────────────────────────────────────────────────────────────────

export const DEPTH_RULES_EN = `
## Depth Requirements
- Use analytical language: "suggests", "indicates", "demonstrates", "implies"
- Use comparisons: "however", "in contrast", "compared to", "whereas"
- Figures/equations/tables: explain significance, not just "see Fig./Eq./Table X"
- Each visual asset discussion should be ≥25 words explaining its meaning
`;

export const DEPTH_RULES_ZH = `
## 深度要求
- 使用分析性语言："表明"、"暗示"、"证明"、"意味着"
- 使用比较："然而"、"相比之下"、"与...相比"、"而"
- 图/公式/表：解释其意义，不要只写"见图/公式/表X"
- 每个视觉资产的讨论应≥25词，解释其含义
`;

export const SYSTEM_PROMPT_ZH = `你是一位专业的学术写作专家，专注于高能物理综述文章。
你的任务是根据提供的 claims 和 evidence 撰写综述论文的一个章节。

## 防止幻觉（关键！）
1. **只能使用下面提供的 claim_text 和 source_context 中的内容**
2. **禁止添加原文没有的推断、结论或事实**
3. 解释时使用限定词（"可能"、"或许"、"表明"）
4. 每个事实陈述必须能追溯到具体的 claim
5. 如果 claim 标记为 is_abstract_fallback=true，它包含完整摘要 - 用作上下文

## 写作规则
1. **引用限制（硬性规则 - 违反将失败！）：**
   - 只能引用下方 allowed_citations 列表中的论文
   - 引用任何不在列表中的论文 = 立即拒绝
   - 验证系统将检测并拒绝未授权的引用
   - 如果不确定某个引用，不要使用它
2. 每个事实陈述必须使用 \\cite{inspire:recid} 格式引用
3. 使用正式学术文体，禁止使用 bullet points 或 numbered lists
4. 每段应综合多篇论文的信息
5. 实质性地讨论图表和公式，而不仅仅是提及
6. 使用 \\cite{key} 引用，\\ref{label} 引用图表/公式
7. 每段至少 4 句话，禁止单句成段

## cite_only 论文
对于标记为 cite_only 的论文（无可用 claims）：
- 不要讨论其具体内容
- 只在段落末尾引用："See also Refs.~\\cite{xxx}."
- 不要编造这些论文的内容

输出格式：
返回 LaTeX 格式的章节内容。`;

// ─────────────────────────────────────────────────────────────────────────────
// User Prompt Builder (shared between client and internal modes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncate text to max length with ellipsis
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function buildGlobalContextBlock(
  ctx: WritingPacket['global_context'],
  wordBudget: WritingPacket['word_budget'],
  currentSectionNumber: string
): string {
  if (!ctx && !wordBudget) return '';

  const parts: string[] = [];
  parts.push('## Global Context (for cross-referencing)');

  if (ctx) {
    parts.push(`Paper: "${ctx.paper_title}"`);
    parts.push(`Topic: ${ctx.paper_topic}`);
  }

  if (wordBudget) {
    parts.push('');
    parts.push('### Word Budget for This Section');
    parts.push(`Target: ${wordBudget.min_words}-${wordBudget.max_words} words`);
  }

  if (ctx?.toc && ctx.toc.length > 0) {
    parts.push('');
    parts.push('### Table of Contents');
    for (const sec of ctx.toc) {
      const marker = sec.section_number === currentSectionNumber ? '**YOU ARE HERE**' : '';
      parts.push(`${sec.section_number}. ${sec.title} ${marker}`.trimEnd());
      if (sec.key_claims.length > 0) {
        parts.push(`   Key points: ${sec.key_claims.slice(0, 3).join('; ')}`);
      }
      if (sec.key_assets.length > 0) {
        parts.push(`   Key assets: ${sec.key_assets.slice(0, 6).join(', ')}`);
      }
    }
  }

  if (ctx?.cross_ref_hints) {
    parts.push('');
    parts.push('### Cross-Reference Guidance');
    if (ctx.cross_ref_hints.this_section_defines.length > 0) {
      parts.push(`You will DEFINE: ${ctx.cross_ref_hints.this_section_defines.join(', ')}`);
    }
    if (ctx.cross_ref_hints.this_section_may_reference.length > 0) {
      parts.push(`You MAY REFERENCE: ${ctx.cross_ref_hints.this_section_may_reference.join(', ')}`);
    }
    if (ctx.cross_ref_hints.later_sections_will_use.length > 0) {
      parts.push(`Later sections WILL USE: ${ctx.cross_ref_hints.later_sections_will_use.join(', ')}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build prompt from WritingPacket (convenience wrapper)
 * Uses packet.instructions and packet.constraints for consistency
 * Applies token optimization by truncating long content
 */
export function buildPromptFromPacket(
  packet: WritingPacket,
  correctionFeedback?: string[]
): string {
  const parts: string[] = [];

  // Section info
  parts.push(`## Section: ${packet.section.number} - ${packet.section.title}`);
  parts.push(`Type: ${packet.section.type}\n`);

  // Paper context for anti-hallucination (especially Introduction/Summary)
  if (packet.context.topic || packet.context.title) {
    parts.push('## Paper Context (IMPORTANT - stay on topic!):');
    if (packet.context.topic) {
      parts.push(`Topic: ${packet.context.topic}`);
    }
    if (packet.context.title) {
      parts.push(`Title: ${packet.context.title}`);
    }
    parts.push('');
  }

  // Global context + per-section word budget (Phase 0)
  const globalCtx = buildGlobalContextBlock(packet.global_context, packet.word_budget, packet.section.number);
  if (globalCtx) {
    parts.push(globalCtx);
    parts.push('');
  }

  // Claims with source context (context truncated for token optimization, claims preserved)
  parts.push('## Claims to Cover (ONLY use content from these claims):');
  for (const claim of packet.assigned_claims) {
    parts.push(`\n### [${claim.claim_id}]`);

    // Claims are NOT truncated to preserve content quality
    parts.push(`Text: ${claim.claim_text}`);

    if (claim.category) {
      parts.push(`Category: ${claim.category}`);
    }
    parts.push(`Paper IDs: ${claim.paper_ids.join(', ')}`);

    // Source context - truncated for token optimization
    // Skip for abstract claims (already self-contained)
    const claimIsAbstract = (claim as { is_abstract_fallback?: boolean }).is_abstract_fallback;
    if (claim.source_context && !claimIsAbstract) {
      if (claim.source_context.before) {
        parts.push(`Context before: ${truncate(claim.source_context.before, MAX_CONTEXT_CHARS)}`);
      }
      if (claim.source_context.after) {
        parts.push(`Context after: ${truncate(claim.source_context.after, MAX_CONTEXT_CHARS)}`);
      }
    }
  }

  // Assigned visual assets (equations/figures/tables) - for anti-hallucination + verifiable coverage.
  const suggested_word_count = packet.word_budget && Number.isFinite(packet.word_budget.min_words) && Number.isFinite(packet.word_budget.max_words)
    ? Math.round((packet.word_budget.min_words + packet.word_budget.max_words) / 2)
    : undefined;
  const assetBlock = buildAssignedAssetsBlock(packet.assigned_assets, { suggested_word_count });
  if (assetBlock.content) {
    parts.push('');
    parts.push(assetBlock.content);
  }

  // Allowed citations - with strong warning
  parts.push(`\n## Allowed Citations (STRICT - ONLY THESE ARE VALID!):`);
  parts.push(packet.allowed_citations.join(', '));
  parts.push('');
  parts.push('⚠️ WARNING: Using ANY citation NOT in this list will cause your output to FAIL verification.');
  parts.push('If a paper is not listed above, DO NOT cite it, even if you know it exists.');

  // Constraints from packet (handle both hard and soft constraints)
  parts.push(`\n## Guidelines:`);
  if (isSoftDepthConfig(packet.constraints)) {
    // Soft constraints - suggestions instead of requirements
    const c = packet.constraints;
    parts.push(`- Suggested paragraphs: ${c.suggested_paragraphs.min}-${c.suggested_paragraphs.max}`);
    parts.push(`- Suggested sentences per paragraph: ${c.suggested_sentences_per_paragraph.min}-${c.suggested_sentences_per_paragraph.max}`);
    if (c.suggested_equations > 0) parts.push(`- Suggested equations: ${c.suggested_equations}`);
    if (c.suggested_figures > 0) parts.push(`- Suggested figures: ${c.suggested_figures}`);
    if (c.suggested_tables > 0) parts.push(`- Suggested tables: ${c.suggested_tables}`);
    if (c.optional_elements.length > 0) {
      parts.push(`- Consider including: ${c.optional_elements.join(', ')}`);
    }
  } else {
    // Hard constraints (legacy)
    const c = packet.constraints;
    parts.push(`- Min paragraphs: ${c.min_paragraphs}`);
    parts.push(`- Min sentences per paragraph: ${c.min_sentences_per_paragraph}`);
    parts.push(`- Min equations: ${c.min_equations}`);
    parts.push(`- Min figures: ${c.min_figures}`);
    if (c.min_tables !== undefined) {
      parts.push(`- Min tables: ${c.min_tables}`);
    }
    if (c.required_elements.length > 0) {
      parts.push(`- Required elements: ${c.required_elements.join(', ')}`);
    }
  }

  // Instructions from packet (use packet.instructions for consistency)
  if (packet.instructions) {
    parts.push(`\n## Instructions:`);
    if (packet.instructions.core.length > 0) {
      parts.push(`Core: ${packet.instructions.core.join('; ')}`);
    }
    if (packet.instructions.prohibitions.length > 0) {
      parts.push(`Prohibitions: ${packet.instructions.prohibitions.join('; ')}`);
    }
    if (packet.instructions.requirements.length > 0) {
      parts.push(`Requirements: ${packet.instructions.requirements.join('; ')}`);
    }
  }

  // Correction feedback (for retry)
  if (correctionFeedback && correctionFeedback.length > 0) {
    parts.push(`\n## CORRECTION REQUIRED:`);
    for (const fb of correctionFeedback) {
      parts.push(`- ${fb}`);
    }
  }

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Client Mode Instructions (wrapper around shared prompts)
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_INSTRUCTIONS_EN = (bibtexKeys: string) => `${SYSTEM_PROMPT_EN}

## Post-Generation Submission (Evidence-first)
After generating content, use the M13 N-best + Judge pipeline (N>=2 required) so the server can:
- enforce hard gates (no silent fallback)
- verify citations (allowlist/orphan/unauthorized checks)
- check originality (N-gram overlap)

Tool:
1. hep_run_writing_create_section_candidates_packet_v1 (then follow next_actions: stage candidates → submit candidates → judge → submit judge decision)

## BibTeX Citation Keys
${bibtexKeys}`;

export const CLIENT_INSTRUCTIONS_ZH = (bibtexKeys: string) => `${SYSTEM_PROMPT_ZH}

## 生成后提交（Evidence-first）
生成内容后，请使用 M13 的 N-best + Judge 工具链（N>=2 必须满足），以便服务端执行：
- 硬门（禁止 silent fallback）
- 引用验证（allowlist/orphan/unauthorized）
- 原创性检测（N-gram 重合度）

工具：
1. hep_run_writing_create_section_candidates_packet_v1（然后按 next_actions：stage candidates → submit candidates → judge → submit judge decision）

## BibTeX 引用键
${bibtexKeys}`;
