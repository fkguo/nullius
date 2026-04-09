import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

describe('literature-workflows package boundary', () => {
  it('stays free of hep-mcp as a generic workflow authority dependency', () => {
    const packageJsonPath = path.join(repoRoot, 'packages', 'literature-workflows', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.['@autoresearch/hep-mcp']).toBeUndefined();
    expect(packageJson.devDependencies?.['@autoresearch/hep-mcp']).toBeUndefined();
  });

  it('does not import hep-mcp sources to resolve generic workflow plans', () => {
    const providerProfilesPath = path.join(repoRoot, 'packages', 'literature-workflows', 'src', 'providerProfiles.ts');
    const providerProfilesSource = fs.readFileSync(providerProfilesPath, 'utf8');

    expect(providerProfilesSource).not.toContain('@autoresearch/hep-mcp');
  });
});
