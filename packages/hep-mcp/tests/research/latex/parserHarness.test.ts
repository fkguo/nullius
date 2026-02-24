/**
 * Parser Harness Tests
 * Tests for LaTeX parsing utilities (fail-fast)
 */

import { describe, it, expect } from 'vitest';
import {
  createEmptyRegistry,
  scanPreambleForMacros,
  isEnvironmentMacro,
  shouldSkipNode,
  safeParseLatex,
  type UserMacroRegistry,
  type ParentChain,
} from '../../../src/tools/research/latex/parserHarness.js';
import { latexParser } from 'latex-utensils';

describe('Parser Harness', () => {
  describe('UserMacroRegistry', () => {
    it('should create empty registry', () => {
      const registry = createEmptyRegistry();

      expect(registry.environmentMacros.size).toBe(0);
      expect(registry.environmentBeginMacros.size).toBe(0);
      expect(registry.environmentEndMacros.size).toBe(0);
      expect(registry.commandMacros.size).toBe(0);
      expect(registry.rawDefinitions).toHaveLength(0);
    });

    it('should scan preamble for environment macros', () => {
      const content = `
\\documentclass{article}
\\newcommand{\\be}{\\begin{equation}}
\\newcommand{\\ee}{\\end{equation}}
\\begin{document}
`;
      const registry = scanPreambleForMacros(content);

      expect(registry.environmentMacros.get('be')).toBe('equation');
      expect(registry.environmentBeginMacros.get('be')).toBe('equation');
      expect(registry.environmentEndMacros.get('ee')).toBe('equation');
    });

    it('should scan preamble for def macros', () => {
      const content = `
\\documentclass{article}
\\def\\ba{\\begin{align}}
\\begin{document}
`;
      const registry = scanPreambleForMacros(content);

      expect(registry.environmentMacros.get('ba')).toBe('align');
    });

    it('should include common HEP macros', () => {
      const registry = scanPreambleForMacros('');

      // Common environment macros
      expect(registry.environmentMacros.get('be')).toBe('equation');
      expect(registry.environmentMacros.get('ba')).toBe('align');
      expect(registry.environmentBeginMacros.get('be')).toBe('equation');
      expect(registry.environmentEndMacros.get('ee')).toBe('equation');

      // Common command macros
      expect(registry.commandMacros.get('GeV')).toBe('\\mathrm{GeV}');
      expect(registry.commandMacros.get('MeV')).toBe('\\mathrm{MeV}');
    });

    it('should check if command is environment macro', () => {
      const registry = scanPreambleForMacros('');

      expect(isEnvironmentMacro('be', registry)).toBe('equation');
      expect(isEnvironmentMacro('unknown', registry)).toBeUndefined();
    });
  });

  describe('shouldSkipNode', () => {
    it('should skip comment nodes', () => {
      const commentNode = { kind: 'comment', content: 'test' } as any;

      expect(shouldSkipNode(commentNode)).toBe(true);
    });

    it('should not skip regular nodes', () => {
      const textNode = { kind: 'text.string', content: 'test' } as any;

      expect(shouldSkipNode(textNode)).toBe(false);
    });
  });

  describe('safeParseLatex', () => {
    it('should parse valid LaTeX at full level', () => {
      const content = '\\section{Test} Hello world.';
      const result = safeParseLatex(content);

      expect(result.ast).toBeTruthy();
      expect(result.recovered).toBe(false);
    });

    it('should return AST for simple content', () => {
      const content = '$E = mc^2$';
      const result = safeParseLatex(content);

      expect(result.recovered).toBe(false);
      expect(result.ast.content.length).toBeGreaterThan(0);
    });

    it('should handle empty content', () => {
      const result = safeParseLatex('');

      expect(result.recovered).toBe(false);
      expect(result.ast).toBeTruthy();
    });

    it('should recover from common unbalanced brace issues', () => {
      // Common arXiv issue: TM{$_{010}$ (unmatched "{") parses after brace balancing.
      const result = safeParseLatex('TM{$_{010}$');
      expect(result.recovered).toBe(true);
    });

    it('should respect timeout option', () => {
      const content = '\\section{Test}';
      const result = safeParseLatex(content, { timeout: 10000 });

      expect(result.recovered).toBe(false);
    });

    it('should fail-fast when parsing cannot succeed', () => {
      expect(() => safeParseLatex('\\', { file: 'bad.tex' })).toThrowError(
        'LaTeX parse failed (fail-fast): bad.tex'
      );
    });
  });
});
