import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import { latexParser } from 'latex-utensils';
import { buildToolSamplingMetadata } from '../../../core/sampling-metadata.js';
import { extractSamplingText } from '../../../core/semantics/quantitySampling.js';
import { extractEquations, type Equation } from './equationExtractor.js';
import {
  buildKeyEquationAssessmentPrompt,
  parseKeyEquationSamplingResponse,
  type KeyEquationImportanceBand,
  type KeyEquationSelectionStatus,
} from './keyEquationSampling.js';
import type { LatexAst, LatexNode } from './parser.js';
import { extractAbstract, extractText } from './sectionExtractor.js';
import { sha256Hex, type SemanticAssessmentProvenance } from '../semantic/semanticProvenance.js';

const IMPORTANCE_HINTS = [
  'key result', 'main result', 'central result', 'principal result',
  'key equation', 'main equation', 'central equation', 'fundamental equation',
  'important', 'crucial', 'essential', 'primary',
  'master equation', 'defining equation', 'basic equation',
  'our result', 'final result', 'main finding',
];
const KEY_SECTIONS = ['abstract', 'summary', 'conclusion', 'conclusions', 'results', 'discussion'];
export const DEEP_ANALYZE_INTERNAL_TOOL_NAME = 'inspire_deep_analyze_internal' as const;

export interface KeyEquation extends Equation {
  candidate_key: string;
  selection_status: KeyEquationSelectionStatus;
  importance_band?: KeyEquationImportanceBand;
  importance_score: number;
  confidence: number;
  reference_count: number;
  section?: string;
  in_key_section: boolean;
  context_text?: string;
  context_keywords: string[];
  selection_rationale?: string;
  provenance: SemanticAssessmentProvenance;
}

export interface KeyEquationOptions {
  max_equations?: number;
  min_score?: number;
  include_inline?: boolean;
  context_window?: number;
  document_title?: string;
  abstract?: string;
  tool_name?: string;
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
}

type KeyEquationCandidate = {
  equation: Equation;
  candidate_key: string;
  reference_count: number;
  section?: string;
  in_key_section: boolean;
  context_text?: string;
  context_keywords: string[];
  candidate_priority: number;
  signal_summary: string[];
};

function countReferences(texContent: string): Map<string, number> {
  const refCounts = new Map<string, number>();
  for (const pattern of [/\\ref\{([^}]+)\}/g, /\\eqref\{([^}]+)\}/g, /\\cref\{([^}]+)\}/g, /\\autoref\{([^}]+)\}/g, /\\Cref\{([^}]+)\}/g]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(texContent)) !== null) {
      for (const label of match[1].split(',').map(v => v.trim()).filter(Boolean)) {
        refCounts.set(label, (refCounts.get(label) ?? 0) + 1);
      }
    }
  }
  return refCounts;
}

function findSectionAtPosition(nodes: LatexNode[], targetIndex: number): string | undefined {
  let currentSection: string | undefined;
  let nodeIndex = 0;
  const traverse = (nodeList: LatexNode[]) => {
    for (const node of nodeList) {
      if (nodeIndex > targetIndex) return;
      if (latexParser.isCommand(node) && ['section', 'subsection', 'subsubsection', 'chapter'].includes(node.name)) {
        const arg = node.args[0];
        if (arg && latexParser.isGroup(arg)) currentSection = extractText(arg.content);
      }
      nodeIndex += 1;
      if (latexParser.isEnvironment(node)) traverse(node.content);
    }
  };
  traverse(nodes);
  return currentSection;
}

function findKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  return IMPORTANCE_HINTS.filter(hint => lower.includes(hint));
}

function isKeySection(sectionName?: string): boolean {
  if (!sectionName) return false;
  const lower = sectionName.toLowerCase();
  return KEY_SECTIONS.some(section => lower.includes(section));
}

function extractContext(texContent: string, equationLatex: string, windowSize: number): string {
  const idx = texContent.indexOf(equationLatex);
  if (idx === -1) return '';
  return texContent
    .slice(Math.max(0, idx - windowSize), Math.min(texContent.length, idx + equationLatex.length + windowSize))
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveCandidatePriority(candidate: Omit<KeyEquationCandidate, 'candidate_priority' | 'signal_summary' | 'candidate_key' | 'equation'>): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = Math.min(candidate.reference_count, 4) * 3;
  if (candidate.reference_count > 0) signals.push(`ref_count:${candidate.reference_count}`);
  if (candidate.section) signals.push(`section:${candidate.section}`);
  if (candidate.in_key_section) {
    score += 3;
    signals.push('key_section_hint');
  }
  if (candidate.context_keywords.length > 0) {
    score += Math.min(candidate.context_keywords.length, 2) * 2;
    signals.push(`context_keywords:${candidate.context_keywords.slice(0, 2).join('|')}`);
  }
  if (candidate.context_text) signals.push('local_context');
  return { score, signals };
}

function importanceScore(status: KeyEquationSelectionStatus, band?: KeyEquationImportanceBand): number {
  if (status !== 'selected') return 0;
  if (band === 'high') return 90;
  if (band === 'medium') return 60;
  return 35;
}

function fallbackCandidates(
  candidates: KeyEquationCandidate[],
  selectionStatus: KeyEquationSelectionStatus,
  provenanceStatus: SemanticAssessmentProvenance['status'],
  reasonCode: string,
  promptVersion: string,
  inputHash: string,
  model?: string,
): KeyEquation[] {
  return candidates.map(candidate => ({
    ...candidate.equation,
    candidate_key: candidate.candidate_key,
    selection_status: selectionStatus,
    importance_score: 0,
    confidence: 0,
    reference_count: candidate.reference_count,
    section: candidate.section,
    in_key_section: candidate.in_key_section,
    context_text: candidate.context_text,
    context_keywords: candidate.context_keywords,
    selection_rationale: reasonCode,
    provenance: {
      backend: selectionStatus === 'unavailable' ? 'diagnostic_fallback' : 'mcp_sampling',
      status: provenanceStatus,
      used_fallback: true,
      reason_code: reasonCode,
      prompt_version: promptVersion,
      input_hash: inputHash,
      model,
      signals: candidate.signal_summary,
    },
  }));
}

export async function identifyKeyEquations(
  ast: LatexAst,
  texContent: string,
  options: KeyEquationOptions = {},
): Promise<KeyEquation[]> {
  const {
    max_equations = 10,
    min_score = 20,
    include_inline = false,
    context_window = 300,
    document_title,
    abstract = extractAbstract(ast),
    tool_name = DEEP_ANALYZE_INTERNAL_TOOL_NAME,
    createMessage,
  } = options;
  const promptVersion = 'sem11_key_equation_importance_v1';
  let equations = extractEquations(ast, { content: texContent });
  if (!include_inline) equations = equations.filter(eq => eq.type !== 'inline');

  const refCounts = countReferences(texContent);
  const candidates = equations
    .map((equation, index) => {
      const section = findSectionAtPosition(ast.content, index);
      const contextText = extractContext(texContent, equation.latex, context_window);
      const contextKeywords = findKeywords(contextText);
      const seed = {
        reference_count: equation.label ? (refCounts.get(equation.label) ?? 0) : 0,
        section,
        in_key_section: isKeySection(section),
        context_text: contextText || undefined,
        context_keywords: contextKeywords,
      };
      const derived = deriveCandidatePriority(seed);
      return {
        equation,
        candidate_key: equation.label || `eq_${index + 1}`,
        ...seed,
        candidate_priority: derived.score,
        signal_summary: derived.signals,
      };
    })
    .sort((a, b) => b.candidate_priority - a.candidate_priority)
    .slice(0, Math.max(max_equations, 6));

  if (candidates.length === 0) return [];

  const inputHash = sha256Hex(JSON.stringify({
    document_title: document_title ?? '',
    abstract,
    candidates: candidates.map(candidate => ({
      candidate_key: candidate.candidate_key,
      label: candidate.equation.label ?? null,
      latex: candidate.equation.latex,
      reference_count: candidate.reference_count,
      section: candidate.section ?? null,
      signal_summary: candidate.signal_summary,
    })),
  }));

  if (!createMessage) {
    return fallbackCandidates(candidates, 'unavailable', 'unavailable', 'sampling_unavailable', promptVersion, inputHash);
  }

  let response: CreateMessageResult;
  try {
    response = await createMessage({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: buildKeyEquationAssessmentPrompt({
            prompt_version: promptVersion,
            document_title,
            abstract,
            candidates: candidates.map(candidate => ({
              candidate_key: candidate.candidate_key,
              label: candidate.equation.label,
              latex: candidate.equation.latex,
              reference_count: candidate.reference_count,
              section: candidate.section,
              context_text: candidate.context_text,
              signal_summary: candidate.signal_summary,
            })),
          }),
        },
      }],
      maxTokens: 900,
      metadata: buildToolSamplingMetadata({
        tool: tool_name,
        module: 'sem11_key_equation_importance',
        promptVersion,
        costClass: 'medium',
      }),
    });
  } catch {
    return fallbackCandidates(candidates, 'unavailable', 'unavailable', 'sampling_error', promptVersion, inputHash);
  }

  const parsed = parseKeyEquationSamplingResponse(extractSamplingText(response.content));
  if (!parsed) {
    return fallbackCandidates(candidates, 'unavailable', 'invalid', 'invalid_response', promptVersion, inputHash, response.model);
  }
  if (parsed.overall_status === 'abstained') {
    return fallbackCandidates(candidates, 'abstained', 'abstained', 'model_abstained', promptVersion, inputHash, response.model);
  }

  const evaluations = new Map(parsed.evaluations.map(item => [item.candidate_key, item]));
  return candidates
    .map(candidate => {
      const evaluation = evaluations.get(candidate.candidate_key);
      const selectionStatus = evaluation?.selection_status ?? 'uncertain';
      const importanceBand = evaluation?.importance_band ?? (selectionStatus === 'selected' ? 'medium' : undefined);
      const provenance: SemanticAssessmentProvenance = {
        backend: 'mcp_sampling',
        status: 'applied',
        used_fallback: false,
        reason_code: evaluation?.reason_code ?? 'not_selected',
        prompt_version: promptVersion,
        input_hash: inputHash,
        model: response.model,
        signals: candidate.signal_summary,
      };
      return {
        ...candidate.equation,
        candidate_key: candidate.candidate_key,
        selection_status: selectionStatus,
        importance_band: importanceBand,
        importance_score: importanceScore(selectionStatus, importanceBand),
        confidence: evaluation?.confidence ?? 0.25,
        reference_count: candidate.reference_count,
        section: candidate.section,
        in_key_section: candidate.in_key_section,
        context_text: candidate.context_text,
        context_keywords: candidate.context_keywords,
        selection_rationale: evaluation?.reason?.trim() || undefined,
        provenance,
      };
    })
    .filter(eq => eq.selection_status !== 'selected' || eq.importance_score >= min_score)
    .sort((a, b) => {
      const rank = (value: KeyEquationSelectionStatus) => value === 'selected' ? 0 : value === 'uncertain' ? 1 : value === 'abstained' ? 2 : 3;
      return rank(a.selection_status) - rank(b.selection_status)
        || b.importance_score - a.importance_score
        || b.confidence - a.confidence;
    })
    .slice(0, max_equations);
}

export function summarizeKeyEquations(keyEquations: KeyEquation[]): Array<{
  latex: string;
  label?: string;
  importance?: KeyEquationImportanceBand;
  selection_status: KeyEquationSelectionStatus;
  description: string;
}> {
  return keyEquations.map(eq => ({
    latex: eq.latex,
    label: eq.label,
    importance: eq.importance_band,
    selection_status: eq.selection_status,
    description: [
      eq.selection_rationale,
      eq.reference_count > 0 ? `ref×${eq.reference_count}` : null,
      eq.section ? `in ${eq.section}` : null,
    ].filter(Boolean).join('; ') || eq.provenance.reason_code,
  }));
}
