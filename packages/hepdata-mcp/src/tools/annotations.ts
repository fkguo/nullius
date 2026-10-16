/**
 * Risk levels and behaviour hints for the hepdata-mcp tools, from which
 * `getTools` derives the MCP annotations (rules in @nullius/shared
 * tool-annotations.ts). hep-mcp re-exports these tools and reads these same
 * tables, so both servers list the same hints.
 */

import {
  HEPDATA_DOWNLOAD,
  HEPDATA_GET_RECORD,
  HEPDATA_GET_TABLE,
  HEPDATA_SEARCH,
  type ToolBehaviourHintTable,
  type ToolRiskTable,
} from '@nullius/shared';

export const HEPDATA_TOOL_RISK_LEVELS: ToolRiskTable = {
  [HEPDATA_SEARCH]: 'read',
  [HEPDATA_GET_RECORD]: 'read',
  [HEPDATA_GET_TABLE]: 'read',
  // Replaces an existing submission file of the same record and format;
  // requires _confirm.
  [HEPDATA_DOWNLOAD]: 'destructive',
};

export const HEPDATA_TOOL_HINTS: ToolBehaviourHintTable = {
  [HEPDATA_SEARCH]: { openWorld: true, reason: 'Queries hepdata.net; writes nothing.' },
  [HEPDATA_GET_RECORD]: { openWorld: true, reason: 'Queries hepdata.net; writes nothing.' },
  [HEPDATA_GET_TABLE]: { openWorld: true, reason: 'Queries hepdata.net and returns the table inline; writes nothing.' },
  [HEPDATA_DOWNLOAD]: {
    idempotent: true,
    openWorld: true,
    reason: 'Downloads from hepdata.net to a path fixed by record id and format, replacing a previous download there; a repeat rewrites the same file.',
  },
};
