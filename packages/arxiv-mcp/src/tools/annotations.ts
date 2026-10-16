/**
 * Risk levels and behaviour hints for the arxiv-mcp tools, from which
 * `getTools` derives the MCP annotations (rules in @nullius/shared
 * tool-annotations.ts). hep-mcp re-exports these tools and reads these same
 * tables, so both servers list the same hints.
 */

import {
  ARXIV_GET_METADATA,
  ARXIV_PAPER_SOURCE,
  ARXIV_SEARCH,
  type ToolBehaviourHintTable,
  type ToolRiskTable,
} from '@nullius/shared';

export const ARXIV_TOOL_RISK_LEVELS: ToolRiskTable = {
  [ARXIV_SEARCH]: 'read',
  [ARXIV_GET_METADATA]: 'read',
  // mode=content downloads the source or PDF into the tool's own download dir.
  [ARXIV_PAPER_SOURCE]: 'write',
};

export const ARXIV_TOOL_HINTS: ToolBehaviourHintTable = {
  [ARXIV_SEARCH]: {
    openWorld: true,
    reason: 'Queries the arXiv API; writes only rate-limit bookkeeping.',
  },
  [ARXIV_GET_METADATA]: {
    openWorld: true,
    reason: 'Queries the arXiv API; writes only rate-limit bookkeeping.',
  },
  [ARXIV_PAPER_SOURCE]: {
    destructive: true,
    idempotent: true,
    openWorld: true,
    reason: 'Fetches from arxiv.org; mode=content writes the paper into a fixed per-paper dir of its download area, replacing an earlier archive, PDF or extracted file there; a repeat returns the cached copy or rewrites the same paths.',
  },
};
