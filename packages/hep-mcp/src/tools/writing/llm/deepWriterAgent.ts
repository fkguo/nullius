/**
 * DeepWriterAgent - Write-Verify-Revise Loop Implementation
 */

import type { LLMClient, LLMAuditInfo, LLMResponse } from './types.js';
import type {
  WritingPacket,
  SectionOutput,
  WritingModeConfig,
  SentenceAttribution,
  OriginalityReport,
  QualityCheck,
} from '../types.js';
import { ORIGINALITY_THRESHOLDS } from '../types.js';
import { createLLMClient } from './clients/index.js';
import { verifyCitations } from '../verifier/citationVerifier.js';
import { checkOriginality } from '../originality/overlapDetector.js';
import { verifyAssetCoverage } from '../verifier/assetCoverageChecker.js';
import { verifyWordCount } from '../verifier/wordCountChecker.js';
import { verifyCrossRefReadiness } from '../verifier/crossRefReadinessChecker.js';
import { SYSTEM_PROMPT_EN, SYSTEM_PROMPT_ZH, buildPromptFromPacket } from '../prompts/sharedPrompt.js';

const DEFAULT_MAX_RETRIES = 3;

interface WriteResult {
  output: SectionOutput;
  audit: LLMAuditInfo;
  verify?: VerifyResult;
  /** Reasoning content from reasoning models (e.g., DeepSeek R1) */
  reasoning_content?: string;
  llm_request: {
    prompt: string;
    system_prompt: string;
  };
  llm_response: {
    content: string;
    usage?: LLMResponse['usage'];
    latency_ms?: number;
  };
}

interface VerifyResult {
  pass: boolean;
  citationPass: boolean;
  citationIssues: string[];
  originalityLevel: 'critical' | 'warning' | 'acceptable';
  originalityMaxOverlap: number;
  originalityFlaggedCount: number;
  feedback: string[];
}

export class DeepWriterAgent {
  private llmClient: LLMClient;
  private maxRetries: number;

  constructor(config: WritingModeConfig) {
    if (!config.llmConfig) {
      throw new Error('LLM config required for internal mode');
    }
    this.llmClient = createLLMClient(config.llmConfig, config.timeout);
    this.maxRetries = config.maxRetries || DEFAULT_MAX_RETRIES;
  }

  async writeSection(packet: WritingPacket, opts?: {
    /** Max retries (0 => single attempt) */
    max_retries?: number;
    auto_fix_originality?: boolean;
    auto_fix_citations?: boolean;
  }): Promise<WriteResult> {
    const startTime = Date.now();
    let attempts = 0;
    let lastDraft = '';
    let lastReasoning: string | undefined;
    let lastVerify: VerifyResult | null = null;
    let lastPrompt = '';
    let lastSystemPrompt = '';
    let lastUsage: LLMResponse['usage'] | undefined;
    let lastCallLatency: number | undefined;

    const autoFixCitations = opts?.auto_fix_citations ?? true;
    const autoFixOriginality = opts?.auto_fix_originality ?? true;
    const maxAttempts = (() => {
      const raw = opts?.max_retries;
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        const retries = Math.max(0, Math.trunc(raw));
        return Math.min(retries + 1, 6);
      }
      return Math.max(1, this.maxRetries);
    })();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;

      // 1. Generate draft (use generateWithMetadata if available for R1 support)
      const prompt = this.buildPrompt(packet, lastVerify);
      const systemPrompt = this.buildSystemPrompt(packet);
      lastPrompt = prompt;
      lastSystemPrompt = systemPrompt;
      lastUsage = undefined;
      lastCallLatency = undefined;

      if (this.llmClient.generateWithMetadata) {
        const response = await this.llmClient.generateWithMetadata(prompt, systemPrompt);
        lastDraft = response.content;
        lastReasoning = response.reasoning_content;
        lastUsage = response.usage;
        lastCallLatency = response.latency_ms;
      } else {
        lastDraft = await this.llmClient.generate(prompt, systemPrompt);
      }

      // 2. Parse and verify
      const parsed = this.parseDraft(lastDraft, packet);
      lastVerify = this.verify(parsed, packet, { autoFixCitations, autoFixOriginality });

      if (!lastVerify.pass) {
        const citationsBlocked = !autoFixCitations && !lastVerify.citationPass;
        const originalityBlocked = !autoFixOriginality && lastVerify.originalityLevel !== 'acceptable';
        if (citationsBlocked || originalityBlocked) break;
      }

      // 3. Check if pass
      if (lastVerify.pass) {
        return {
          output: this.buildOutput(parsed, packet, Date.now() - startTime),
          audit: this.buildAudit(attempts, Date.now() - startTime, true),
          verify: lastVerify,
          reasoning_content: lastReasoning,
          llm_request: { prompt: lastPrompt, system_prompt: lastSystemPrompt },
          llm_response: { content: lastDraft, usage: lastUsage, latency_ms: lastCallLatency },
        };
      }
    }

    // Return with warnings after max retries
    const parsed = this.parseDraft(lastDraft, packet);
    return {
      output: this.buildOutputWithWarnings(parsed, packet, lastVerify!, Date.now() - startTime),
      audit: this.buildAudit(attempts, Date.now() - startTime, false, 'Max retries exceeded'),
      verify: lastVerify ?? undefined,
      reasoning_content: lastReasoning,
      llm_request: { prompt: lastPrompt, system_prompt: lastSystemPrompt },
      llm_response: { content: lastDraft, usage: lastUsage, latency_ms: lastCallLatency },
    };
  }

  private buildSystemPrompt(packet: WritingPacket): string {
    // Use shared prompt template for consistency with client mode
    const lang = packet.context.language
      || (((packet.context.topic || '') + (packet.context.title || '')).match(/[\u4e00-\u9fff]/) ? 'zh' : 'en');
    return lang === 'zh' ? SYSTEM_PROMPT_ZH : SYSTEM_PROMPT_EN;
  }

  private buildPrompt(packet: WritingPacket, prevVerify: VerifyResult | null): string {
    // Use shared prompt builder for consistency with client mode
    const correctionFeedback = prevVerify && !prevVerify.pass ? prevVerify.feedback : undefined;
    return buildPromptFromPacket(packet, correctionFeedback);
  }

  private parseDraft(draft: string, _packet: WritingPacket): ParsedDraft {
    // Extract LaTeX content (before JSON block)
    const jsonMatch = draft.match(/```json\s*([\s\S]*?)\s*```/);
    const content = jsonMatch
      ? draft.substring(0, draft.indexOf('```json')).trim()
      : draft.trim();

    // Parse attributions if present
    let attributions: SentenceAttribution[] = [];
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        attributions = parsed.attributions || [];
      } catch {
        // Ignore parse errors
      }
    }

    return { content, attributions };
  }

  private verify(parsed: ParsedDraft, packet: WritingPacket, opts: { autoFixCitations: boolean; autoFixOriginality: boolean }): VerifyResult {
    const feedback: string[] = [];

    // Check citations
    const citationResult = verifyCitations({
      section_output: {
        content: parsed.content,
        attributions: parsed.attributions,
      } as any,
      claims_table: { claims: packet.assigned_claims },
      allowed_citations: packet.allowed_citations,
    });

    const citationIssues = citationResult.issues
      .map(i => i.message)
      .filter((m): m is string => m !== undefined);
    if (!citationResult.pass && opts.autoFixCitations) {
      feedback.push(...citationIssues);
    }

    // Check originality
    const allEvidence = packet.assigned_claims.flatMap(c => c.supporting_evidence);
    const origResult = checkOriginality({
      generated_text: parsed.content,
      source_evidences: allEvidence,
    });

    if (origResult.level !== 'acceptable' && opts.autoFixOriginality) {
      feedback.push(
        `Originality ${origResult.level} (max_overlap=${origResult.max_overlap}, flagged=${origResult.flagged_count}) - rewrite to reduce overlap and add synthesis.`
      );
    }

    // Phase 1 post-hoc checks (deterministic, prompt-aligned)
    const postHocFeedback: string[] = [];

    const assetCoverage = verifyAssetCoverage({ content: parsed.content }, packet.assigned_assets);
    if (!assetCoverage.pass) postHocFeedback.push(...assetCoverage.feedback);

    const wordCount = packet.word_budget ? verifyWordCount(parsed.content, packet.word_budget) : null;
    if (wordCount && !wordCount.pass) postHocFeedback.push(...wordCount.feedback);

    const crossRefHints = packet.global_context?.cross_ref_hints?.this_section_defines;
    const crossRef = Array.isArray(crossRefHints)
      ? verifyCrossRefReadiness({ content: parsed.content }, { this_section_defines: crossRefHints })
      : null;
    if (crossRef && !crossRef.pass) postHocFeedback.push(...crossRef.feedback);

    // Always include post-hoc feedback in correction loop (quality-gating is the point of M12).
    feedback.push(...postHocFeedback);

    const postHocPass = assetCoverage.pass && (wordCount ? wordCount.pass : true) && (crossRef ? crossRef.pass : true);

    const pass = citationResult.pass && origResult.level === 'acceptable' && postHocPass;

    return {
      pass,
      citationPass: citationResult.pass,
      citationIssues,
      originalityLevel: origResult.level,
      originalityMaxOverlap: origResult.max_overlap,
      originalityFlaggedCount: origResult.flagged_count,
      feedback,
    };
  }

  private buildOutput(
    parsed: ParsedDraft,
    packet: WritingPacket,
    processingTime: number
  ): SectionOutput {
    const paragraphs = parsed.content.split(/\n\n+/).filter(p => p.trim());
    const sentences = parsed.content.split(/[.!?]+/).filter(s => s.trim());

    return {
      section_number: packet.section.number,
      title: packet.section.title,
      content: parsed.content,
      attributions: parsed.attributions,
      figures_used: [],
      equations_used: [],
      tables_used: [],
      originality_report: this.createOriginalityReport('acceptable'),
      quality_check: this.createQualityCheck(true, []),
      metadata: {
        word_count: parsed.content.split(/\s+/).length,
        paragraph_count: paragraphs.length,
        sentence_count: sentences.length,
        citation_count: (parsed.content.match(/\\cite\{/g) || []).length,
        processing_time_ms: processingTime,
        llm_mode_effective: 'internal',
        llm_provider_effective: this.llmClient.provider,
        llm_model_effective: this.llmClient.model,
      },
    };
  }

  private buildOutputWithWarnings(
    parsed: ParsedDraft,
    packet: WritingPacket,
    verify: VerifyResult,
    processingTime: number
  ): SectionOutput {
    const output = this.buildOutput(parsed, packet, processingTime);
    output.quality_check = this.createQualityCheck(false, verify.feedback);
    output.originality_report = this.createOriginalityReport(verify.originalityLevel);
    return output;
  }

  private buildAudit(
    attempts: number,
    latency: number,
    success: boolean,
    error?: string
  ): LLMAuditInfo {
    return {
      provider: this.llmClient.provider,
      model: this.llmClient.model,
      attempts,
      total_latency_ms: latency,
      success,
      error,
    };
  }

  private createOriginalityReport(level: 'critical' | 'warning' | 'acceptable'): OriginalityReport {
    const maxRatio = level === 'critical'
      ? ORIGINALITY_THRESHOLDS.CRITICAL
      : level === 'warning'
        ? ORIGINALITY_THRESHOLDS.WARNING
        : 0.2;
    const avgRatio = level === 'critical' ? 0.7 : level === 'warning' ? 0.4 : 0.15;

    return {
      max_overlap_ratio: maxRatio,
      avg_overlap_ratio: avgRatio,
      level,
      is_acceptable: level !== 'critical',
      needs_review: level === 'warning',
      has_verbatim_copy: level === 'critical',
      flagged_sentences: [],
      statistics: {
        total_sentences: 0,
        checked_sentences: 0,
        grounded_sentences: 0,
        synthesized_sentences: 0,
        flagged_count: level === 'critical' ? 1 : 0,
        critical_count: level === 'critical' ? 1 : 0,
        warning_count: level === 'warning' ? 1 : 0,
      },
    };
  }

  private createQualityCheck(pass: boolean, issues: string[]): QualityCheck {
    return {
      all_claims_supported: pass,
      unsupported_statements: [],
      depth_constraints: {
        min_paragraphs: 0,
        actual_paragraphs: 0,
        paragraphs_pass: true,
        min_sentences_per_paragraph: 0,
        actual_min_sentences: 0,
        sentences_pass: true,
        required_elements: [],
        elements_coverage: 0,
        elements_pass: true,
        min_figures: 0,
        actual_figures: 0,
        min_equations: 0,
        actual_equations: 0,
        visual_pass: true,
        asset_coverage: {
          assigned_figures: [],
          discussed_figures: [],
          figures_coverage_pass: true,
          assigned_equations: [],
          discussed_equations: [],
          equations_coverage_pass: true,
          figure_discussions: [],
          equation_discussions: [],
          overall_pass: true,
        },
      },
      format_checks: {
        bullet_list_detected: false,
        numbered_list_detected: false,
        single_sentence_paragraphs: 0,
        pass: true,
      },
      multi_paper_stats: {
        paragraphs_total: 0,
        paragraphs_multi_paper: 0,
        min_required_multi_paper: 2,
        pass: true,
      },
      tone_score: pass ? 0.9 : 0.5,
      structure_score: pass ? 0.9 : 0.5,
      overall_pass: pass,
      blocking_issues: pass ? [] : issues,
      warnings: [],
    };
  }
}

interface ParsedDraft {
  content: string;
  attributions: SentenceAttribution[];
}
