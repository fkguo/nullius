import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

function readFilesRecursively(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap(entry => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return readFilesRecursively(entryPath);
    return entryPath;
  });
}

describe('literature-workflows package boundary', () => {
  it('stays free of hep-mcp as a checked-in workflow-pack dependency', () => {
    const packageJsonPath = path.join(repoRoot, 'packages', 'literature-workflows', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const standaloneCliPath = path.join(repoRoot, 'packages', 'literature-workflows', 'src', 'cli.ts');

    expect(packageJson.dependencies?.['@autoresearch/hep-mcp']).toBeUndefined();
    expect(packageJson.devDependencies?.['@autoresearch/hep-mcp']).toBeUndefined();
    expect(packageJson).not.toHaveProperty('bin');
    expect(fs.existsSync(standaloneCliPath)).toBe(false);
  });

  it('does not import hep-mcp sources to resolve the checked-in workflow pack', () => {
    const providerProfilesPath = path.join(repoRoot, 'packages', 'literature-workflows', 'src', 'providerProfiles.ts');
    const providerProfilesSource = fs.readFileSync(providerProfilesPath, 'utf8');

    expect(providerProfilesSource).not.toContain('@autoresearch/hep-mcp');
  });

  it('keeps generic literature workflow source free of hep-mcp source imports', () => {
    const sourceDir = path.join(repoRoot, 'packages', 'literature-workflows', 'src');
    const sourceText = readFilesRecursively(sourceDir)
      .filter(filePath => filePath.endsWith('.ts'))
      .map(filePath => fs.readFileSync(filePath, 'utf8'))
      .join('\n');

    expect(sourceText).not.toContain('@autoresearch/hep-mcp');
    expect(sourceText).not.toContain('packages/hep-mcp');
  });
});
