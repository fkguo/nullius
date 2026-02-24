import { invalidParams } from '@autoresearch/shared';

export interface ZoteroConfig {
  baseUrl: string;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw invalidParams('ZOTERO_BASE_URL cannot be empty');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidParams('Invalid ZOTERO_BASE_URL', { value: raw });
  }

  if (url.protocol !== 'http:') {
    throw invalidParams('ZOTERO_BASE_URL must use http://', { value: raw });
  }

  // Product constraint: Zotero Local API only.
  if (url.hostname !== '127.0.0.1') {
    throw invalidParams('ZOTERO_BASE_URL must be http://127.0.0.1:23119 (Local API only)', {
      hostname: url.hostname,
    });
  }
  if (url.port !== '23119') {
    throw invalidParams('ZOTERO_BASE_URL must be http://127.0.0.1:23119 (Local API only)', {
      port: url.port || '(default)',
    });
  }

  url.hash = '';
  url.search = '';
  url.pathname = '';

  const normalized = url.toString().replace(/\/$/, '');
  return normalized;
}

export function getZoteroConfig(): ZoteroConfig {
  const baseUrl = normalizeBaseUrl(process.env.ZOTERO_BASE_URL || 'http://127.0.0.1:23119');

  return { baseUrl };
}

