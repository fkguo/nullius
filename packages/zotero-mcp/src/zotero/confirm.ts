import { randomUUID } from 'crypto';

import { invalidParams } from '@autoresearch/shared';

export interface ZoteroAddConfirmPayloadV1 {
  planned: { mode: 'create' } | { mode: 'update_existing'; item_key: string };
  prepared_item: {
    data: Record<string, unknown>;
    title?: string;
    identifiers: { doi?: string; arxiv_id?: string; inspire_recid?: string };
  };
  write: {
    effective_collection_keys: string[];
    allow_library_root: boolean;
    tags: string[];
    note?: string;
    file_path?: string;
    dedupe: 'return_existing' | 'update_existing' | 'error_on_existing';
    open_in_zotero: boolean;
  };
  selection?: { kind: 'collection'; collection_key: string; path: string } | { kind: 'library_root'; path: string };
}

export type ConfirmAction =
  | {
      kind: 'zotero_add_v1';
      payload: {
        params: ZoteroAddConfirmPayloadV1;
      };
    };

export interface StoredConfirmAction {
  token: string;
  created_at: string;
  expires_at: string;
  action: ConfirmAction;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;

const ACTIONS_BY_TOKEN = new Map<string, { stored: StoredConfirmAction; expiresAtMs: number }>();

function nowMs(): number {
  return Date.now();
}

function parseTtlMs(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

function resolveTtlMs(): number {
  const fromEnv = parseTtlMs(process.env.ZOTERO_CONFIRM_TTL_MS);
  const ttl = fromEnv ?? DEFAULT_TTL_MS;
  if (ttl <= 0) return DEFAULT_TTL_MS;
  return Math.min(ttl, MAX_TTL_MS);
}

function cleanupExpiredConfirmActions(currentMs: number): void {
  for (const [token, entry] of ACTIONS_BY_TOKEN.entries()) {
    if (entry.expiresAtMs <= currentMs) {
      ACTIONS_BY_TOKEN.delete(token);
    }
  }
}

export function createConfirmAction(action: ConfirmAction): { confirm_token: string; expires_at: string } {
  const token = randomUUID();
  const ttlMs = resolveTtlMs();
  const createdAtMs = nowMs();
  const expiresAtMs = createdAtMs + ttlMs;

  cleanupExpiredConfirmActions(createdAtMs);

  const stored: StoredConfirmAction = {
    token,
    created_at: new Date(createdAtMs).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    action,
  };
  ACTIONS_BY_TOKEN.set(token, { stored, expiresAtMs });

  return { confirm_token: token, expires_at: stored.expires_at };
}

export function consumeConfirmAction(confirmToken: string): StoredConfirmAction {
  const token = confirmToken.trim();
  if (!token) throw invalidParams('confirm_token cannot be empty');
  if (token.length > 200) throw invalidParams('confirm_token too long', { length: token.length, max: 200 });

  const current = nowMs();
  cleanupExpiredConfirmActions(current);

  const entry = ACTIONS_BY_TOKEN.get(token);
  if (!entry) {
    throw invalidParams('Unknown or expired confirm_token');
  }
  if (entry.expiresAtMs <= current) {
    ACTIONS_BY_TOKEN.delete(token);
    throw invalidParams('confirm_token expired');
  }

  ACTIONS_BY_TOKEN.delete(token);
  return entry.stored;
}
