/**
 * Shared Zotero helper utilities.
 * Extracted from zotero-mcp/src/zotero/tools.ts (NEW-R04 dedup).
 */

import { invalidParams } from '@autoresearch/shared';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeZoteroKey(token: string, fieldName: string): string {
  const v = token.trim();
  if (!v) throw invalidParams(`${fieldName} cannot be empty`);
  if (v.length > 200) throw invalidParams(`${fieldName} too long`, { length: v.length, max: 200 });
  if (v.includes('/') || v.includes('\\')) {
    throw invalidParams(`${fieldName} must not include path separators`);
  }
  if (v === '.' || v === '..' || v.includes('..')) {
    throw invalidParams(`${fieldName} contains unsafe segment`);
  }
  return v;
}

export function parseAttachmentSummaries(children: unknown[]): Array<{
  attachment_key: string;
  filename?: string;
  content_type?: string;
  link_mode?: string;
}> {
  const attachments: Array<{
    attachment_key: string;
    filename?: string;
    content_type?: string;
    link_mode?: string;
  }> = [];

  for (const child of children) {
    if (!isRecord(child)) continue;
    const key = child.key;
    if (typeof key !== 'string' || !key.trim()) continue;
    const data = isRecord(child.data) ? child.data : {};
    const itemType = data.itemType;
    if (itemType !== 'attachment') continue;

    const filename = typeof data.filename === 'string' ? data.filename : undefined;
    const contentType = typeof data.contentType === 'string' ? data.contentType : undefined;
    const linkMode = typeof data.linkMode === 'string' ? data.linkMode : undefined;

    attachments.push({
      attachment_key: key.trim(),
      filename,
      content_type: contentType,
      link_mode: linkMode,
    });
  }

  return attachments;
}

export function isPdfAttachment(att: { filename?: string; content_type?: string }): boolean {
  const byType = (att.content_type || '').toLowerCase().includes('pdf');
  const byName = (att.filename || '').toLowerCase().endsWith('.pdf');
  return byType || byName;
}
