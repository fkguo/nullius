/**
 * Risk levels and behaviour hints for the zotero-mcp tools, from which
 * `getTools` derives the MCP annotations (rules in @nullius/shared
 * tool-annotations.ts). hep-mcp re-exports these tools and reads these same
 * tables, so both servers list the same hints.
 *
 * Every Zotero call goes to the Zotero app's local API on 127.0.0.1.
 * zotero_add and zotero_delete only preview and issue a confirm token;
 * zotero_confirm performs the write.
 */

import {
  ZOTERO_ADD,
  ZOTERO_CONFIRM,
  ZOTERO_DELETE,
  ZOTERO_EXPORT_ITEMS,
  ZOTERO_FIND_ITEMS,
  ZOTERO_GET_SELECTED_COLLECTION,
  ZOTERO_LOCAL,
  ZOTERO_SEARCH_ITEMS,
  type ToolBehaviourHintTable,
  type ToolRiskTable,
} from '@nullius/shared';

export const ZOTERO_TOOL_RISK_LEVELS: ToolRiskTable = {
  // mode=download_attachment may write a temp copy of the attachment and
  // return its path.
  [ZOTERO_LOCAL]: 'write',
  [ZOTERO_FIND_ITEMS]: 'read',
  [ZOTERO_SEARCH_ITEMS]: 'read',
  [ZOTERO_EXPORT_ITEMS]: 'read',
  [ZOTERO_GET_SELECTED_COLLECTION]: 'read',
  [ZOTERO_ADD]: 'write',
  // Gated by its own confirm token; can trash or erase items (see hints).
  [ZOTERO_CONFIRM]: 'write',
  [ZOTERO_DELETE]: 'write',
};

export const ZOTERO_TOOL_HINTS: ToolBehaviourHintTable = {
  [ZOTERO_LOCAL]: {
    openWorld: false,
    reason: 'Reads the Zotero local API; mode=download_attachment can write a new temp copy of the attachment on each call.',
  },
  [ZOTERO_FIND_ITEMS]: { openWorld: false, reason: 'Reads the Zotero local API.' },
  [ZOTERO_SEARCH_ITEMS]: { openWorld: false, reason: 'Reads the Zotero local API.' },
  [ZOTERO_EXPORT_ITEMS]: { openWorld: false, reason: 'Reads the Zotero local API and returns the export inline.' },
  [ZOTERO_GET_SELECTED_COLLECTION]: { openWorld: false, reason: 'Asks the local Zotero connector for the selected collection.' },
  [ZOTERO_ADD]: {
    openWorld: true,
    reason: 'Preview only: resolves metadata from INSPIRE (CrossRef fallback) and issues a new confirm token each call; no library write.',
  },
  [ZOTERO_CONFIRM]: {
    destructive: true,
    idempotent: true,
    openWorld: false,
    reason: 'Executes a previewed add or delete through the Zotero app on 127.0.0.1; a delete token trashes or erases items; the token is spent before execution, so a repeat is refused.',
  },
  [ZOTERO_DELETE]: {
    openWorld: false,
    reason: 'Preview only: checks the items on the Zotero local API and issues a new confirm token each call; no library write.',
  },
};
