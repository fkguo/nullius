import { describe, it, expect } from 'vitest';
import {
  createRunArtifactRef,
  makeRunArtifactUri,
  createArtifactRefV1,
  isHepArtifactUri,
  parseHepArtifactUri,
} from '../artifact-ref.js';

describe('makeRunArtifactUri', () => {
  it('should construct hep:// URI', () => {
    expect(makeRunArtifactUri('run123', 'data.json')).toBe(
      'hep://runs/run123/artifact/data.json'
    );
  });

  it('should encode special characters', () => {
    const uri = makeRunArtifactUri('run with space', 'file+name.json');
    expect(uri).toContain('run%20with%20space');
    expect(uri).toContain('file%2Bname.json');
  });
});

describe('createRunArtifactRef', () => {
  it('should create lightweight ref with default mimeType', () => {
    const ref = createRunArtifactRef('myrun', 'catalog.jsonl');
    expect(ref.name).toBe('catalog.jsonl');
    expect(ref.uri).toBe('hep://runs/myrun/artifact/catalog.jsonl');
    expect(ref.mimeType).toBe('application/json');
  });

  it('should accept custom mimeType', () => {
    const ref = createRunArtifactRef('myrun', 'report.tex', 'text/x-latex');
    expect(ref.mimeType).toBe('text/x-latex');
  });
});

describe('createArtifactRefV1', () => {
  const validSha256 = 'a'.repeat(64);

  it('should create valid ArtifactRefV1', () => {
    const ref = createArtifactRefV1({
      uri: 'hep://runs/r1/artifact/data.json',
      sha256: validSha256,
    });
    expect(ref.uri).toBe('hep://runs/r1/artifact/data.json');
    expect(ref.sha256).toBe(validSha256);
  });

  it('should include optional fields when provided', () => {
    const ref = createArtifactRefV1({
      uri: 'hep://runs/r1/artifact/data.json',
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

  it('should reject empty uri', () => {
    expect(() => createArtifactRefV1({ uri: '', sha256: validSha256 })).toThrow('non-empty uri');
  });

  it('should reject invalid sha256', () => {
    expect(() => createArtifactRefV1({ uri: 'hep://r/a', sha256: 'bad' })).toThrow('valid sha256');
    expect(() => createArtifactRefV1({ uri: 'hep://r/a', sha256: 'A'.repeat(64) })).toThrow('valid sha256');
  });
});

describe('isHepArtifactUri', () => {
  it('should accept valid hep:// artifact URIs', () => {
    expect(isHepArtifactUri('hep://runs/myrun/artifact/data.json')).toBe(true);
    expect(isHepArtifactUri('hep://runs/run%20id/artifact/file%2B.json')).toBe(true);
  });

  it('should reject non-hep URIs', () => {
    expect(isHepArtifactUri('http://example.com')).toBe(false);
    expect(isHepArtifactUri('hep://projects/p1')).toBe(false);
    expect(isHepArtifactUri('')).toBe(false);
  });
});

describe('parseHepArtifactUri', () => {
  it('should parse valid URI', () => {
    const result = parseHepArtifactUri('hep://runs/myrun/artifact/data.json');
    expect(result).toEqual({ runId: 'myrun', artifactName: 'data.json' });
  });

  it('should decode percent-encoded components', () => {
    const result = parseHepArtifactUri('hep://runs/run%20id/artifact/file%2B.json');
    expect(result).toEqual({ runId: 'run id', artifactName: 'file+.json' });
  });

  it('should return null for invalid URI', () => {
    expect(parseHepArtifactUri('not-a-uri')).toBeNull();
    expect(parseHepArtifactUri('hep://projects/p1')).toBeNull();
  });

  it('should return null for malformed percent-encoding', () => {
    expect(parseHepArtifactUri('hep://runs/%E0%A4%A/artifact/data.json')).toBeNull();
  });
});
