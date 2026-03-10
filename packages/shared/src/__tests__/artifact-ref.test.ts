import { describe, it, expect } from 'vitest';
import {
  createArtifactRefV1,
  createScopedArtifactRef,
  isScopedArtifactUri,
  makeScopedArtifactUri,
  parseScopedArtifactUri,
} from '../artifact-ref.js';

describe('makeScopedArtifactUri', () => {
  it('constructs scoped artifact URIs', () => {
    expect(makeScopedArtifactUri({
      scheme: 'example',
      scope: 'records',
      scopeId: 'record123',
      artifactName: 'data.json',
    })).toBe('example://records/record123/artifact/data.json');
  });

  it('encodes special characters', () => {
    const uri = makeScopedArtifactUri({
      scheme: 'openalex',
      scope: 'works',
      scopeId: 'run with space',
      artifactName: 'file+name.json',
    });
    expect(uri).toContain('run%20with%20space');
    expect(uri).toContain('file%2Bname.json');
  });
});

describe('createScopedArtifactRef', () => {
  it('creates lightweight refs with default mimeType', () => {
    const ref = createScopedArtifactRef({
      scheme: 'example',
      scope: 'records',
      scopeId: 'item-1',
      artifactName: 'catalog.jsonl',
    });
    expect(ref.name).toBe('catalog.jsonl');
    expect(ref.uri).toBe('example://records/item-1/artifact/catalog.jsonl');
    expect(ref.mimeType).toBe('application/json');
  });

  it('accepts custom mimeType', () => {
    const ref = createScopedArtifactRef(
      {
        scheme: 'openalex',
        scope: 'works',
        scopeId: 'W123',
        artifactName: 'report.tex',
      },
      'text/x-latex',
    );
    expect(ref.mimeType).toBe('text/x-latex');
  });
});

describe('createArtifactRefV1', () => {
  const validSha256 = 'a'.repeat(64);

  it('creates valid ArtifactRefV1', () => {
    const ref = createArtifactRefV1({
      uri: 'openalex://works/W1/artifact/data.json',
      sha256: validSha256,
    });
    expect(ref.uri).toBe('openalex://works/W1/artifact/data.json');
    expect(ref.sha256).toBe(validSha256);
  });

  it('includes optional fields when provided', () => {
    const ref = createArtifactRefV1({
      uri: 'openalex://works/W1/artifact/data.json',
      sha256: validSha256,
      kind: 'strategy',
      schema_version: 1,
      size_bytes: 1024,
      produced_by: 'test-agent',
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(ref.kind).toBe('strategy');
    expect(ref.schema_version).toBe(1);
    expect(ref.size_bytes).toBe(1024);
    expect(ref.produced_by).toBe('test-agent');
    expect(ref.created_at).toBe('2026-01-01T00:00:00Z');
  });

  it('rejects empty uri', () => {
    expect(() => createArtifactRefV1({ uri: '', sha256: validSha256 })).toThrow('non-empty uri');
  });

  it('rejects invalid sha256', () => {
    expect(() => createArtifactRefV1({ uri: 'openalex://r/a', sha256: 'bad' })).toThrow('valid sha256');
    expect(() => createArtifactRefV1({ uri: 'openalex://r/a', sha256: 'A'.repeat(64) })).toThrow('valid sha256');
  });
});

describe('isScopedArtifactUri', () => {
  it('accepts valid scoped artifact URIs', () => {
    expect(isScopedArtifactUri('hep://runs/myrun/artifact/data.json', { scheme: 'hep', scope: 'runs' })).toBe(true);
    expect(isScopedArtifactUri('openalex://works/W123/artifact/file%2B.json', { scheme: 'openalex', scope: 'works' })).toBe(true);
  });

  it('rejects non-matching URIs', () => {
    expect(isScopedArtifactUri('http://example.com', { scheme: 'hep', scope: 'runs' })).toBe(false);
    expect(isScopedArtifactUri('hep://projects/p1', { scheme: 'hep', scope: 'runs' })).toBe(false);
    expect(isScopedArtifactUri('', { scheme: 'hep', scope: 'runs' })).toBe(false);
  });
});

describe('parseScopedArtifactUri', () => {
  it('parses valid URIs', () => {
    const result = parseScopedArtifactUri(
      'openalex://works/W123/artifact/data.json',
      { scheme: 'openalex', scope: 'works' },
    );
    expect(result).toEqual({ scheme: 'openalex', scope: 'works', scopeId: 'W123', artifactName: 'data.json' });
  });

  it('decodes percent-encoded components', () => {
    const result = parseScopedArtifactUri('hep://runs/run%20id/artifact/file%2B.json', { scheme: 'hep', scope: 'runs' });
    expect(result).toEqual({ scheme: 'hep', scope: 'runs', scopeId: 'run id', artifactName: 'file+.json' });
  });

  it('returns null for invalid URIs', () => {
    expect(parseScopedArtifactUri('not-a-uri', { scheme: 'hep', scope: 'runs' })).toBeNull();
    expect(parseScopedArtifactUri('hep://projects/p1', { scheme: 'hep', scope: 'runs' })).toBeNull();
  });

  it('returns null for malformed percent-encoding', () => {
    expect(parseScopedArtifactUri('hep://runs/%E0%A4%A/artifact/data.json', { scheme: 'hep', scope: 'runs' })).toBeNull();
  });
});
