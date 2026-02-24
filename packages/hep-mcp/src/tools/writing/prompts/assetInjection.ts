import type { WritingPacket } from '../types.js';

export const ASSET_INJECTION_BUDGET = {
  max_equations_per_section: 8,
  max_figures_per_section: 5,
  max_tables_per_section: 3,

  max_snippet_chars_equation: 600,
  max_snippet_chars_figure: 500,
  max_snippet_chars_table: 600,

  // Soft ceiling: still allow larger output, but record diagnostics + truncate if wildly exceeded.
  max_total_asset_block_chars: 6000,
};

const ASSET_BUDGET_BASE_WORD_COUNT = 1000;
const ASSET_BUDGET_MIN_SCALE_FACTOR = 0.2; // 200 words
const ASSET_BUDGET_MAX_SCALE_FACTOR = 6; // 6000 words

export interface AssetBlockResult {
  content: string;
  diagnostics: {
    equations_total: number;
    equations_kept: number;
    figures_total: number;
    figures_kept: number;
    tables_total: number;
    tables_kept: number;
    total_chars: number;
    selection_truncated: boolean;
    selection_reason?: string;
    truncated: boolean;
    truncation_reason?: string;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Scale asset budgets based on section word count.
 *
 * Quality-first principle: longer sections need more visual/math assets to remain grounded and rich.
 *
 * Baseline (1000 words): 8 eq, 5 fig, 3 tables, 6000 total chars.
 *
 * Examples (rounded, clamped):
 * - 200 words  → 2 eq, 1 fig, 1 table, 1200 chars
 * - 1000 words → 8 eq, 5 fig, 3 tables, 6000 chars
 * - 4000 words → 32 eq, 20 fig, 12 tables, 24000 chars
 */
function scaleAssetBudget(suggestedWordCount: number): typeof ASSET_INJECTION_BUDGET {
  if (!Number.isFinite(suggestedWordCount) || suggestedWordCount <= 0) return ASSET_INJECTION_BUDGET;

  const scaleFactor = clamp(
    suggestedWordCount / ASSET_BUDGET_BASE_WORD_COUNT,
    ASSET_BUDGET_MIN_SCALE_FACTOR,
    ASSET_BUDGET_MAX_SCALE_FACTOR
  );

  return {
    ...ASSET_INJECTION_BUDGET,
    max_equations_per_section: Math.round(ASSET_INJECTION_BUDGET.max_equations_per_section * scaleFactor),
    max_figures_per_section: Math.round(ASSET_INJECTION_BUDGET.max_figures_per_section * scaleFactor),
    max_tables_per_section: Math.round(ASSET_INJECTION_BUDGET.max_tables_per_section * scaleFactor),
    max_total_asset_block_chars: Math.round(ASSET_INJECTION_BUDGET.max_total_asset_block_chars * scaleFactor),
  };
}

function resolveAssetInjectionBudget(options?: { budget?: Partial<typeof ASSET_INJECTION_BUDGET>; suggested_word_count?: number }) {
  const scaled = typeof options?.suggested_word_count === 'number'
    ? scaleAssetBudget(options.suggested_word_count)
    : ASSET_INJECTION_BUDGET;
  return { ...scaled, ...(options?.budget ?? {}) };
}

function truncate(text: string, maxLen: number): string {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 3)) + '...';
}

function formatLocator(locator: any): string {
  if (!locator || typeof locator !== 'object') return 'unknown';

  const parts: string[] = [];
  if (locator.latex_file) parts.push(`latex_file=${String(locator.latex_file)}`);
  if (Number.isFinite(locator.latex_line)) parts.push(`latex_line=${String(locator.latex_line)}`);
  if (Number.isFinite(locator.pdf_page)) parts.push(`pdf_page=${String(locator.pdf_page)}`);
  if (locator.section) parts.push(`section=${String(locator.section)}`);
  if (locator.environment) parts.push(`env=${String(locator.environment)}`);
  if (locator.label) parts.push(`label=${String(locator.label)}`);
  return parts.length > 0 ? parts.join(', ') : 'unknown';
}

function buildDiscussionSnippet(asset: any, maxChars: number): string {
  const contexts = Array.isArray(asset?.discussion_contexts) ? asset.discussion_contexts : [];
  const snippet = contexts.length > 0
    ? contexts.join('\n\n')
    : [asset?.locator?.context_before, asset?.locator?.context_after].filter(Boolean).join('\n\n');
  return truncate(snippet, maxChars);
}

function sortByImportance<T extends { importance?: string }>(items: T[]): T[] {
  const rank = (x: string | undefined) => (x === 'high' ? 0 : x === 'medium' ? 1 : x === 'low' ? 2 : 3);
  return [...items].sort((a, b) => rank(a.importance) - rank(b.importance));
}

export function selectAssetsForInjection(
  assets: WritingPacket['assigned_assets'],
  options?: { budget?: Partial<typeof ASSET_INJECTION_BUDGET>; suggested_word_count?: number }
): { selected: WritingPacket['assigned_assets']; diagnostics: AssetBlockResult['diagnostics'] } {
  const budget = resolveAssetInjectionBudget(options);

  const equationsAll = Array.isArray(assets?.equations) ? assets.equations : [];
  const figuresAll = Array.isArray(assets?.figures) ? assets.figures : [];
  const tablesAll = Array.isArray(assets?.tables) ? assets.tables : [];

  const equations = sortByImportance(equationsAll).slice(0, Math.max(0, budget.max_equations_per_section));
  const figures = sortByImportance(figuresAll).slice(0, Math.max(0, budget.max_figures_per_section));
  const tables = tablesAll.slice(0, Math.max(0, budget.max_tables_per_section));

  const selectionTruncated =
    equations.length < equationsAll.length ||
    figures.length < figuresAll.length ||
    tables.length < tablesAll.length;

  return {
    selected: { equations, figures, tables },
    diagnostics: {
      equations_total: equationsAll.length,
      equations_kept: equations.length,
      figures_total: figuresAll.length,
      figures_kept: figures.length,
      tables_total: tablesAll.length,
      tables_kept: tables.length,
      total_chars: 0,
      selection_truncated: selectionTruncated,
      selection_reason: selectionTruncated ? 'per-section top-K budget' : undefined,
      truncated: false,
    },
  };
}

export function buildAssignedAssetsBlock(
  assets: WritingPacket['assigned_assets'],
  options?: { budget?: Partial<typeof ASSET_INJECTION_BUDGET>; suggested_word_count?: number }
): AssetBlockResult {
  const budget = resolveAssetInjectionBudget(options);
  const { selected, diagnostics } = selectAssetsForInjection(assets, options);
  const { equations, figures, tables } = selected;

  const hasAny = equations.length > 0 || figures.length > 0 || tables.length > 0;
  if (!hasAny) {
    return { content: '', diagnostics: { ...diagnostics, total_chars: 0 } };
  }

  const parts: string[] = [];
  parts.push('## Assigned Visual Assets (MUST reference and discuss substantively)');
  parts.push('');
  parts.push('⚠️ STRICT RULES:');
  parts.push('1. Every asset below MUST be referenced AND discussed (≥25 words explanation)');
  parts.push('2. Do NOT fabricate Eq/Fig/Table not in this list');
  parts.push('3. When referencing, prefer LaTeX \\\\eqref{label}/\\\\ref{label} if label is provided; otherwise use the stable marker Eq[asset_id]/Fig[asset_id]/Table[asset_id]');
  parts.push('4. For EACH asset, at least ONCE you MUST discuss it adjacent to its reference (same paragraph, or within the next 2 sentences)');
  parts.push('5. You MAY discuss the same asset again elsewhere (cross-paragraph/section), but you MUST include an explicit pointer again (repeat Eq[...]/Fig[...]/Table[...] or \\\\eqref/\\\\ref); avoid ambiguous "this equation/figure/table"');
  parts.push('6. Ground the discussion in the provided context snippet; do not write generic filler');

  if (equations.length > 0) {
    parts.push('');
    parts.push('### Equations');
    for (const eq of equations as any[]) {
      const headerBits = [
        eq.number ? `Eq. ${String(eq.number)}` : undefined,
        eq.label ? `label: ${String(eq.label)}` : undefined,
      ].filter(Boolean);
      const headerSuffix = headerBits.length > 0 ? ` (${headerBits.join(', ')})` : '';

      parts.push('');
      parts.push(`- **Eq[${String(eq.evidence_id)}]**${headerSuffix}`);
      parts.push('```latex');
      parts.push(truncate(String(eq.latex ?? ''), budget.max_snippet_chars_equation));
      parts.push('```');

      const ctx = buildDiscussionSnippet(eq, budget.max_snippet_chars_equation);
      if (ctx.trim()) parts.push(`Context: ${ctx}`);
      parts.push(`Source: paper_id=${String(eq.paper_id ?? '')}; locator: ${formatLocator(eq.locator)}`);
    }
  }

  if (figures.length > 0) {
    parts.push('');
    parts.push('### Figures');
    for (const fig of figures as any[]) {
      const headerBits = [
        fig.number ? `Fig. ${String(fig.number)}` : undefined,
        fig.label ? `label: ${String(fig.label)}` : undefined,
      ].filter(Boolean);
      const headerSuffix = headerBits.length > 0 ? ` (${headerBits.join(', ')})` : '';

      parts.push('');
      parts.push(`- **Fig[${String(fig.evidence_id)}]**${headerSuffix}`);
      const caption = truncate(String(fig.caption ?? ''), budget.max_snippet_chars_figure);
      if (caption.trim()) parts.push(`Caption: ${caption}`);

      const ctx = buildDiscussionSnippet(fig, budget.max_snippet_chars_figure);
      if (ctx.trim()) parts.push(`Context: ${ctx}`);
      parts.push(`Source: paper_id=${String(fig.paper_id ?? '')}; locator: ${formatLocator(fig.locator)}`);
    }
  }

  if (tables.length > 0) {
    parts.push('');
    parts.push('### Tables');
    for (const tab of tables as any[]) {
      const headerBits = [
        tab.number ? `Table ${String(tab.number)}` : undefined,
        tab.label ? `label: ${String(tab.label)}` : undefined,
      ].filter(Boolean);
      const headerSuffix = headerBits.length > 0 ? ` (${headerBits.join(', ')})` : '';

      parts.push('');
      parts.push(`- **Table[${String(tab.evidence_id)}]**${headerSuffix}`);
      const caption = truncate(String(tab.caption ?? ''), Math.floor(budget.max_snippet_chars_table * 0.6));
      if (caption.trim()) parts.push(`Caption: ${caption}`);
      const summary = truncate(String(tab.content_summary ?? ''), Math.floor(budget.max_snippet_chars_table * 0.6));
      if (summary.trim()) parts.push(`Summary: ${summary}`);

      const ctx = buildDiscussionSnippet(tab, budget.max_snippet_chars_table);
      if (ctx.trim()) parts.push(`Context: ${ctx}`);
      parts.push(`Source: paper_id=${String(tab.paper_id ?? '')}; locator: ${formatLocator(tab.locator)}`);
    }
  }

  let content = parts.join('\n');
  diagnostics.total_chars = content.length;

  if (budget.max_total_asset_block_chars > 0 && content.length > budget.max_total_asset_block_chars * 1.5) {
    diagnostics.truncated = true;
    diagnostics.truncation_reason = 'max_total_asset_block_chars exceeded (soft cap)';
    content = truncate(content, budget.max_total_asset_block_chars);
    diagnostics.total_chars = content.length;
  }

  return { content, diagnostics };
}
