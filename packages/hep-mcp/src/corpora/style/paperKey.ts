import { createHash } from 'crypto';

function sha256HexString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function paperKeyForRecid(recid: string): string {
  const trimmed = recid.trim();
  if (/^\d+$/.test(trimmed)) return `recid_${trimmed}`;
  return `recid_${sha256HexString(trimmed).slice(0, 12)}`;
}

