/**
 * Locator System Golden Tests
 * Tests for precise source location tracking
 */

import { describe, it, expect } from 'vitest';
import {
  createBlockIdGenerator,
  createAnchor,
  nodeToLocator,
  findBlockContainer,
  inferLabelType,
  isRefCommand,
  extractRefTargets,
  buildLocatorIndex,
  validateLocatorPlayback,
  validateLabelsHaveBlocks,
  validateRefsHaveTargets,
  validateLocatorIndex,
  type Locator,
  type Block,
  type LocatorIndex,
} from '../../../src/tools/research/latex/locator.js';
import { latexParser } from 'latex-utensils';

describe('Locator System', () => {
  describe('Block ID Generator', () => {
    it('should create independent generators (concurrency safe)', () => {
      const gen1 = createBlockIdGenerator();
      const gen2 = createBlockIdGenerator();

      expect(gen1('equation')).toBe('equation_1');
      expect(gen1('equation')).toBe('equation_2');
      expect(gen2('equation')).toBe('equation_1'); // Independent counter
      expect(gen2('figure')).toBe('figure_2');
    });

    it('should generate unique IDs with kind prefix', () => {
      const gen = createBlockIdGenerator();

      expect(gen('equation')).toBe('equation_1');
      expect(gen('figure')).toBe('figure_2');
      expect(gen('table')).toBe('table_3');
    });
  });

  describe('createAnchor', () => {
    it('should create anchor with before/after context', () => {
      const content = 'Hello World! This is a test.';
      const anchor = createAnchor(content, 12);

      expect(anchor.before).toBe('Hello World!');
      expect(anchor.after).toBe(' This is a test.');
    });

    it('should handle start of content', () => {
      const content = 'Hello World!';
      const anchor = createAnchor(content, 0);

      expect(anchor.before).toBe('');
      expect(anchor.after.startsWith('Hello')).toBe(true);
    });

    it('should handle end of content', () => {
      const content = 'Hello World!';
      const anchor = createAnchor(content, content.length);

      expect(anchor.before.endsWith('!')).toBe(true);
      expect(anchor.after).toBe('');
    });
  });

  describe('inferLabelType', () => {
    it('should infer equation type from eq: prefix', () => {
      expect(inferLabelType('eq:einstein')).toBe('equation');
    });

    it('should infer figure type from fig: prefix', () => {
      expect(inferLabelType('fig:diagram')).toBe('figure');
    });

    it('should infer table type from tab: prefix', () => {
      expect(inferLabelType('tab:results')).toBe('table');
    });

    it('should infer section type from sec: prefix', () => {
      expect(inferLabelType('sec:intro')).toBe('section');
    });

    it('should infer theorem type from thm: prefix', () => {
      expect(inferLabelType('thm:main')).toBe('theorem');
    });

    it('should return other for unknown prefix', () => {
      expect(inferLabelType('unknown')).toBe('other');
      expect(inferLabelType('custom:label')).toBe('other');
    });
  });

  describe('nodeToLocator', () => {
    it('should convert AST node to Locator', () => {
      const content = '\\section{Test}';
      const ast = latexParser.parse(content);
      const node = ast.content[0];

      const locator = nodeToLocator(node, 'test.tex', content);

      expect(locator.file).toBe('test.tex');
      expect(locator.offset).toBe(0);
      expect(locator.line).toBe(1);
      expect(locator.column).toBe(1);
    });

    it('should include anchor when content provided', () => {
      const content = '\\section{Test}';
      const ast = latexParser.parse(content);
      const node = ast.content[0];

      const locator = nodeToLocator(node, 'test.tex', content);

      expect(locator.anchor).toBeDefined();
    });

    it('should handle node without location', () => {
      const node = { kind: 'text.string', content: 'test' } as any;

      const locator = nodeToLocator(node, 'test.tex');

      expect(locator.unknown).toBe(true);
      expect(locator.offset).toBe(0);
    });
  });

  describe('isRefCommand', () => {
    it('should identify ref commands', () => {
      const content = '\\ref{eq:test}';
      const ast = latexParser.parse(content);
      const node = ast.content[0];

      expect(isRefCommand(node)).toBe(true);
    });

    it('should identify eqref commands', () => {
      const content = '\\eqref{eq:test}';
      const ast = latexParser.parse(content);
      const node = ast.content[0];

      expect(isRefCommand(node)).toBe(true);
    });

    it('should not identify non-ref commands', () => {
      const content = '\\section{Test}';
      const ast = latexParser.parse(content);
      const node = ast.content[0];

      expect(isRefCommand(node)).toBe(false);
    });
  });

  describe('extractRefTargets', () => {
    it('should extract single target', () => {
      const content = '\\ref{eq:test}';
      const ast = latexParser.parse(content);
      const node = ast.content[0];

      const targets = extractRefTargets(node);

      expect(targets).toContain('eq:test');
    });

    it('should extract multiple targets from cref', () => {
      const content = '\\cref{eq:a,eq:b,eq:c}';
      const ast = latexParser.parse(content);
      const node = ast.content[0];

      const targets = extractRefTargets(node);

      expect(targets).toHaveLength(3);
      expect(targets).toContain('eq:a');
      expect(targets).toContain('eq:b');
      expect(targets).toContain('eq:c');
    });
  });

  describe('buildLocatorIndex', () => {
    it('should build index from simple document', () => {
      const content = `
\\begin{equation}
E = mc^2 \\label{eq:einstein}
\\end{equation}
`;
      const ast = latexParser.parse(content);
      const index = buildLocatorIndex(ast, 'test.tex', content);

      expect(index.labels.has('eq:einstein')).toBe(true);
      expect(index.file).toBe('test.tex');
    });

    it('should track multiple labels', () => {
      const content = `
\\begin{equation} \\label{eq:a} \\end{equation}
\\begin{equation} \\label{eq:b} \\end{equation}
`;
      const ast = latexParser.parse(content);
      const index = buildLocatorIndex(ast, 'test.tex', content);

      expect(index.labels.size).toBe(2);
      expect(index.labels.has('eq:a')).toBe(true);
      expect(index.labels.has('eq:b')).toBe(true);
    });

    it('should track references', () => {
      const content = 'See \\ref{eq:test} and \\eqref{eq:other}.';
      const ast = latexParser.parse(content);
      const index = buildLocatorIndex(ast, 'test.tex', content);

      expect(index.allRefs.length).toBe(2);
      expect(index.refs.has('eq:test')).toBe(true);
      expect(index.refs.has('eq:other')).toBe(true);
    });

    it('should be concurrency safe (independent indexes)', () => {
      const content1 = '\\begin{equation} \\label{eq:a} \\end{equation}';
      const content2 = '\\begin{equation} \\label{eq:b} \\end{equation}';

      const ast1 = latexParser.parse(content1);
      const ast2 = latexParser.parse(content2);

      const index1 = buildLocatorIndex(ast1, 'file1.tex', content1);
      const index2 = buildLocatorIndex(ast2, 'file2.tex', content2);

      // Both should have equation_1 as block ID (independent counters)
      const label1 = index1.labels.get('eq:a');
      const label2 = index2.labels.get('eq:b');

      expect(label1?.blockId).toBe('equation_1');
      expect(label2?.blockId).toBe('equation_1');
    });
  });

  describe('Gate Validation', () => {
    describe('validateLocatorPlayback', () => {
      it('should validate valid locator', () => {
        const content = 'Hello World!';
        const locator: Locator = {
          file: 'test.tex',
          offset: 6,
          line: 1,
          column: 7,
        };

        expect(validateLocatorPlayback(locator, content)).toBe(true);
      });

      it('should reject out-of-range offset', () => {
        const content = 'Hello';
        const locator: Locator = {
          file: 'test.tex',
          offset: 100,
          line: 1,
          column: 1,
        };

        expect(validateLocatorPlayback(locator, content)).toBe(false);
      });

      it('should reject negative offset', () => {
        const content = 'Hello';
        const locator: Locator = {
          file: 'test.tex',
          offset: -1,
          line: 1,
          column: 1,
        };

        expect(validateLocatorPlayback(locator, content)).toBe(false);
      });
    });

    describe('validateLabelsHaveBlocks', () => {
      it('should pass for valid index', () => {
        const content = '\\begin{equation} \\label{eq:test} \\end{equation}';
        const ast = latexParser.parse(content);
        const index = buildLocatorIndex(ast, 'test.tex', content);

        const result = validateLabelsHaveBlocks(index);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe('validateRefsHaveTargets', () => {
      it('should pass for valid refs', () => {
        const content = '\\ref{eq:test}';
        const ast = latexParser.parse(content);
        const index = buildLocatorIndex(ast, 'test.tex', content);

        const result = validateRefsHaveTargets(index);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe('validateLocatorIndex', () => {
      it('should validate complete index', () => {
        const content = `
\\begin{equation} \\label{eq:test} \\end{equation}
See \\ref{eq:test}.
`;
        const ast = latexParser.parse(content);
        const index = buildLocatorIndex(ast, 'test.tex', content);

        const result = validateLocatorIndex(index, content);

        expect(result.valid).toBe(true);
      });
    });
  });
});
