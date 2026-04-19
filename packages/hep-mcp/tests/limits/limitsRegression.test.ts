import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readUtf8(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

describe('Limits regression guard (P0 silent truncation)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(here, '../..');

  it('does not reintroduce silent truncation in critical modules', () => {
    const checks: Array<{
      file: string;
      forbid: RegExp;
      reason: string;
    }> = [
      {
        file: path.resolve(pkgRoot, 'src/tools/research/criticalQuestions.ts'),
        forbid: /api\.getReferences\([^)]*,\s*\d+\s*\)/,
        reason: 'Self-citation should not silently truncate references (use full refs or explicit budget + warnings).',
      },
      {
        file: path.resolve(pkgRoot, 'src/tools/research/criticalAnalysis.ts'),
        forbid: /max_search_results:\s*\d+/,
        reason: 'Critical analysis must not hard-code evidence search budgets (should come from tool options).',
      },
      {
        file: path.resolve(pkgRoot, 'src/tools/research/criticalAnalysis.ts'),
        forbid: /max_depth:\s*\d+/,
        reason: 'Critical analysis must not hard-code assumption tracing depth (should come from tool options).',
      },
      {
        file: path.resolve(pkgRoot, 'src/tools/research/evidenceGrading.ts'),
        forbid: /api\.search\(/,
        reason: 'Evidence grading should use searchAll() so max_search_results can exceed 1000 safely and truncation can be warned.',
      },
    ];

    for (const { file, forbid, reason } of checks) {
      const content = readUtf8(file);
      expect(forbid.test(content), `${file}: ${reason}`).toBe(false);
    }
  });

  it('keeps critical research assumption depth explicitly configurable', () => {
    const registryEntryPath = path.resolve(pkgRoot, 'src/tools/registry.ts');
    const registryEntry = readUtf8(registryEntryPath);

    if (registryEntry.includes("export * from './registry/index.js'")) {
      const candidates = [
        path.resolve(pkgRoot, 'src/tools/registry/shared.ts'),
        path.resolve(pkgRoot, 'src/tools/registry/inspireSchemas.ts'),
      ];
      const contents = candidates
        .filter(p => fs.existsSync(p))
        .map(p => readUtf8(p));
      expect(contents.some(content => content.includes('assumption_max_depth'))).toBe(true);
      return;
    }

    expect(registryEntry).toContain('assumption_max_depth');
  });

  it('prevents author list truncation from biasing author-count logic', () => {
    const sharedPaperTypesPath = path.resolve(pkgRoot, '../shared/src/types/paper.ts');
    const sharedPaperTypes = readUtf8(sharedPaperTypesPath);
    expect(sharedPaperTypes).toContain('author_count');

    const criticalQuestions = readUtf8(path.resolve(pkgRoot, 'src/tools/research/criticalQuestions.ts'));
    expect(criticalQuestions).toMatch(/const\s+authorCount\s*=\s*paper\.author_count\s*\?\?/);

    const reviewClassifier = readUtf8(path.resolve(pkgRoot, 'src/tools/research/reviewClassifier.ts'));
    expect(reviewClassifier).toMatch(/const\s+authorCount\s*=\s*paper\.author_count\s*\?\?/);
  });
});
