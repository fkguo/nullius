import { describe, it, expect } from 'vitest';

import { validateInspireApiUrl } from '../../src/api/client.js';

describe('R5: INSPIRE next_url validation (same-origin + endpoint)', () => {
  it('rejects non-same-origin URLs', () => {
    expect(() => validateInspireApiUrl('https://evil.example/api/literature?q=x')).toThrow(/same origin/i);
  });

  it('rejects URLs outside /api', () => {
    expect(() => validateInspireApiUrl('https://inspirehep.net/literature?q=x')).toThrow(/base path/i);
  });

  it('rejects URLs outside required endpoint prefix when specified', () => {
    expect(() =>
      validateInspireApiUrl('https://inspirehep.net/api/authors?q=x', { require_path_prefix: '/api/literature' })
    ).toThrow(/required/i);
  });

  it('rejects URLs that only share a partial prefix with the required endpoint', () => {
    expect(() =>
      validateInspireApiUrl('https://inspirehep.net/api/literature2?q=x', { require_path_prefix: '/api/literature' })
    ).toThrow(/required/i);
  });

  it('enforces max_page_size when provided', () => {
    expect(() =>
      validateInspireApiUrl('https://inspirehep.net/api/literature?q=x&size=1000', { max_page_size: 100 })
    ).toThrow(/exceeds inline limit/i);
  });

  it('rejects URLs with embedded credentials', () => {
    expect(() =>
      validateInspireApiUrl('https://user:pass@inspirehep.net/api/literature?q=x')
    ).toThrow(/credentials/i);
  });

  it('accepts valid INSPIRE API URLs', () => {
    const url = validateInspireApiUrl('https://inspirehep.net/api/literature?q=x&size=25&page=2');
    expect(url.hostname).toBe('inspirehep.net');
    expect(url.pathname).toBe('/api/literature');
  });

  it('accepts default-port URLs that specify an explicit port', () => {
    const url = validateInspireApiUrl('https://inspirehep.net:443/api/literature?q=x&size=25&page=2');
    expect(url.hostname).toBe('inspirehep.net');
    expect(url.pathname).toBe('/api/literature');
  });
});
