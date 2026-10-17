import { getTools, type ToolExposureMode } from '../registry.js';

export interface ToolCatalog {
  mode: ToolExposureMode;
  count: number;
  tools: string[];
}

/**
 * SYNC-02: the checked-in `tool_catalog.{standard,full}.json` is exactly this
 * object — the sorted tool names of one exposure mode and nothing else. No
 * timestamp, no commit hash: the catalog changes only when the registry does,
 * so `git diff` on it is meaningful. Callers set `HEP_ENABLE_ZOTERO=1` before
 * the registry module loads so the full inventory is listed.
 */
export function buildToolCatalog(mode: ToolExposureMode): ToolCatalog {
  const tools = getTools(mode).map(tool => tool.name).sort();
  return { mode, count: tools.length, tools };
}

export function renderToolCatalog(catalog: ToolCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
