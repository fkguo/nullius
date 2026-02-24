import { describe, it, expect } from 'vitest';

import { buildAssignedAssetsBlock, selectAssetsForInjection } from '../../src/tools/writing/prompts/assetInjection.js';
import { buildPromptFromPacket } from '../../src/tools/writing/prompts/sharedPrompt.js';
import type { WritingPacket } from '../../src/tools/writing/types.js';

function makePacket(assets: WritingPacket['assigned_assets']): WritingPacket {
  return {
    section: { number: '2', title: 'Test Section', type: 'body' },
    assigned_claims: [
      {
        claim_id: 'c1',
        claim_no: 'c1',
        claim_text: 'Model A predicts something.',
        category: 'theoretical_prediction',
        status: 'emerging',
        paper_ids: ['111'],
        supporting_evidence: [],
        assumptions: [],
        scope: '',
        evidence_grade: 'theoretical',
        keywords: [],
        is_extractive: false,
      } as any,
    ],
    assigned_assets: assets,
    allowed_citations: ['inspire:111'],
    constraints: {
      min_paragraphs: 2,
      min_sentences_per_paragraph: 3,
      required_elements: [],
      min_figures: 0,
      min_equations: 0,
      citation_density: 0.1,
    },
    instructions: { core: [], prohibitions: [], requirements: [] },
    context: { topic: 'test', title: 'test', glossary: [] },
  };
}

describe('M12.1: Asset Injection', () => {
  it('should build an assigned assets block with stable markers', () => {
    const assets: WritingPacket['assigned_assets'] = {
      equations: [
        {
          kind: 'formula',
          evidence_id: 'eq_abc123',
          paper_id: '111',
          fingerprint: 'fp',
          locator: { latex_file: 'main.tex', latex_line: 10 },
          stance: 'support',
          confidence: 'high',
          latex: 'm_X = m_1 + m_2 - B',
          label: 'eq:mass',
          number: '3',
          importance: 'high',
          discussion_contexts: ['The binding energy B determines the mass splitting.'],
        } as any,
      ],
      figures: [
        {
          kind: 'figure',
          evidence_id: 'fig_xyz789',
          paper_id: '111',
          fingerprint: 'fp',
          locator: { pdf_page: 5 },
          stance: 'support',
          confidence: 'high',
          caption: 'Mass spectrum of the X(3872) candidates.',
          graphics_paths: [],
          discussion_contexts: ['A peak near threshold is visible in the mass spectrum.'],
          importance: 'high',
        } as any,
      ],
      tables: [
        {
          kind: 'table',
          evidence_id: 'tab_def456',
          paper_id: '111',
          fingerprint: 'fp',
          locator: { latex_file: 'main.tex', latex_line: 50 },
          stance: 'neutral',
          confidence: 'medium',
          caption: 'Comparison of mass measurements.',
          content_summary: 'Mass values from different experiments.',
          discussion_contexts: ['The table summarizes systematic differences between experiments.'],
        } as any,
      ],
    };

    const block = buildAssignedAssetsBlock(assets);
    expect(block.content).toContain('## Assigned Visual Assets');
    expect(block.content).toContain('**Eq[eq_abc123]**');
    expect(block.content).toContain('**Fig[fig_xyz789]**');
    expect(block.content).toContain('**Table[tab_def456]**');
    expect(block.diagnostics.truncated).toBe(false);
  });

  it('should enforce per-section budgets (top-K) and record diagnostics', () => {
    const manyEquations = Array.from({ length: 20 }, (_, i) => ({
      kind: 'formula',
      evidence_id: `eq_${String(i + 1).padStart(3, '0')}`,
      paper_id: '111',
      fingerprint: `fp_${i}`,
      locator: { latex_file: 'main.tex', latex_line: i + 1 },
      stance: 'support',
      confidence: 'high',
      latex: `E_${i} = mc^2`,
      importance: 'low',
      discussion_contexts: ['context'],
    })) as any[];

    const block = buildAssignedAssetsBlock({ equations: manyEquations, figures: [], tables: [] });

    expect(block.diagnostics.equations_total).toBe(20);
    expect(block.diagnostics.equations_kept).toBe(8);

    const markerLines = (block.content.match(/^- \*\*Eq\[/gm) || []).length;
    expect(markerLines).toBe(8);
  });

  it('should scale per-section budgets with suggested_word_count', () => {
    const equations = Array.from({ length: 100 }, (_, i) => ({
      kind: 'formula',
      evidence_id: `eq_${i}`,
      paper_id: '111',
      fingerprint: `fp_${i}`,
      locator: {},
      stance: 'support',
      confidence: 'high',
      latex: `E_${i} = mc^2`,
      importance: 'low',
      discussion_contexts: ['context'],
    })) as any[];
    const figures = Array.from({ length: 50 }, (_, i) => ({
      kind: 'figure',
      evidence_id: `fig_${i}`,
      paper_id: '111',
      fingerprint: `fp_${i}`,
      locator: {},
      stance: 'support',
      confidence: 'high',
      caption: `Caption ${i}`,
      graphics_paths: [],
      discussion_contexts: ['context'],
      importance: 'low',
    })) as any[];
    const tables = Array.from({ length: 40 }, (_, i) => ({
      kind: 'table',
      evidence_id: `tab_${i}`,
      paper_id: '111',
      fingerprint: `fp_${i}`,
      locator: {},
      stance: 'neutral',
      confidence: 'medium',
      caption: `Caption ${i}`,
      discussion_contexts: ['context'],
    })) as any[];

    const selection = selectAssetsForInjection({ equations, figures, tables }, { suggested_word_count: 4000 });
    expect(selection.diagnostics.equations_kept).toBe(32);
    expect(selection.diagnostics.figures_kept).toBe(20);
    expect(selection.diagnostics.tables_kept).toBe(12);
  });

  it('should inject assets into the shared section prompt (before allowed citations)', () => {
    const packet = makePacket({ equations: [], figures: [], tables: [] });
    const promptEmpty = buildPromptFromPacket(packet);
    expect(promptEmpty).not.toContain('## Assigned Visual Assets');

    const packetWithAssets = makePacket({
      equations: [{ kind: 'formula', evidence_id: 'eq_1', paper_id: '111', fingerprint: 'fp', locator: {}, stance: 'support', confidence: 'high', latex: 'E=mc^2', importance: 'high' } as any],
      figures: [],
      tables: [],
    });
    const prompt = buildPromptFromPacket(packetWithAssets);
    const idxAssets = prompt.indexOf('## Assigned Visual Assets');
    const idxAllowed = prompt.indexOf('## Allowed Citations');

    expect(idxAssets).toBeGreaterThan(0);
    expect(idxAllowed).toBeGreaterThan(0);
    expect(idxAssets).toBeLessThan(idxAllowed);
  });
});
