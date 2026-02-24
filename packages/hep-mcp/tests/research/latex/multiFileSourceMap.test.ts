import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  applySourceMapToLocatorIndex,
  buildLocatorIndex,
  parseLatex,
  playbackLocator,
  validateLocatorPlayback,
} from '../../../src/tools/research/latex/parser.js';
import { mergeProjectContentWithSourceMap } from '../../../src/tools/research/latex/projectResolver.js';

describe('LaTeX multi-file SourceMap', () => {
  it('maps merged locators back to original files (including subfiles)', () => {
    const fixtureDir = new URL('../../fixtures/latex/multifile/', import.meta.url);
    const mainFilePath = fileURLToPath(new URL('main.tex', fixtureDir));

    const readContent = (file: string) => fs.readFileSync(file, 'utf8');

    const { merged, sourceMap } = mergeProjectContentWithSourceMap(mainFilePath);

    expect(merged).toContain('\\section{Introduction}');
    expect(merged).toContain('\\section{Subfile Section}');

    const ast = parseLatex(merged);
    const index = buildLocatorIndex(ast, mainFilePath, merged);
    applySourceMapToLocatorIndex(index, sourceMap, readContent);

    const mainLabel = index.labels.get('sec:main');
    expect(mainLabel).toBeDefined();
    expect(path.basename(mainLabel!.locator.file)).toBe('main.tex');
    expect(mainLabel!.locator.line).toBe(5);
    expect(mainLabel!.locator.column).toBe(1);
    expect(validateLocatorPlayback(mainLabel!.locator, readContent(mainLabel!.locator.file))).toBe(true);

    const introEq = index.labels.get('eq:einstein');
    expect(introEq).toBeDefined();
    expect(path.basename(introEq!.locator.file)).toBe('intro.tex');
    expect(introEq!.locator.line).toBe(4);
    expect(introEq!.locator.column).toBe(1);
    expect(validateLocatorPlayback(introEq!.locator, readContent(introEq!.locator.file))).toBe(true);
    expect(playbackLocator(introEq!.locator, readContent).snippet).toContain('\\label{eq:einstein}');

    const subfileLabel = index.labels.get('sec:subfile');
    expect(subfileLabel).toBeDefined();
    expect(path.basename(subfileLabel!.locator.file)).toBe('subfile_section.tex');
    expect(subfileLabel!.locator.line).toBe(4);
    expect(subfileLabel!.locator.column).toBe(1);
    expect(validateLocatorPlayback(subfileLabel!.locator, readContent(subfileLabel!.locator.file))).toBe(true);
    expect(playbackLocator(subfileLabel!.locator, readContent).snippet).toContain('\\label{sec:subfile}');
  });
});

