/**
 * Risk levels and behaviour hints for the openalex-mcp tools, from which
 * `getTools` derives the MCP annotations (rules in @nullius/shared
 * tool-annotations.ts). hep-mcp re-exports these tools and reads these same
 * tables, so both servers list the same hints.
 */

import {
  OPENALEX_AUTOCOMPLETE,
  OPENALEX_BATCH,
  OPENALEX_CITATIONS,
  OPENALEX_CONTENT,
  OPENALEX_FILTER,
  OPENALEX_GET,
  OPENALEX_GROUP,
  OPENALEX_RATE_LIMIT,
  OPENALEX_REFERENCES,
  OPENALEX_SEARCH,
  OPENALEX_SEMANTIC_SEARCH,
  type ToolBehaviourHintTable,
  type ToolRiskTable,
} from '@nullius/shared';

const BULK_EXPORT_REASON =
  'Queries api.openalex.org; when max_results exceeds per_page it writes a new results/<id>.jsonl file and returns its path, so each repeat adds another file.';

export const OPENALEX_TOOL_RISK_LEVELS: ToolRiskTable = {
  // Bulk mode (max_results > per_page) writes a results file it returns.
  [OPENALEX_SEARCH]: 'write',
  [OPENALEX_SEMANTIC_SEARCH]: 'read',
  [OPENALEX_GET]: 'read',
  // Bulk mode writes a results file it returns.
  [OPENALEX_FILTER]: 'write',
  [OPENALEX_GROUP]: 'read',
  [OPENALEX_REFERENCES]: 'read',
  // Bulk mode writes a results file it returns.
  [OPENALEX_CITATIONS]: 'write',
  [OPENALEX_BATCH]: 'read',
  [OPENALEX_AUTOCOMPLETE]: 'read',
  // Replaces an existing download of the same work and type; requires _confirm.
  [OPENALEX_CONTENT]: 'destructive',
  [OPENALEX_RATE_LIMIT]: 'read',
};

export const OPENALEX_TOOL_HINTS: ToolBehaviourHintTable = {
  [OPENALEX_SEARCH]: { openWorld: true, reason: BULK_EXPORT_REASON },
  [OPENALEX_SEMANTIC_SEARCH]: { openWorld: true, reason: 'Queries api.openalex.org; writes nothing.' },
  [OPENALEX_GET]: { openWorld: true, reason: 'Queries api.openalex.org; writes nothing.' },
  [OPENALEX_FILTER]: { openWorld: true, reason: BULK_EXPORT_REASON },
  [OPENALEX_GROUP]: { openWorld: true, reason: 'Queries api.openalex.org; writes nothing.' },
  [OPENALEX_REFERENCES]: { openWorld: true, reason: 'Queries api.openalex.org; writes nothing.' },
  [OPENALEX_CITATIONS]: { openWorld: true, reason: BULK_EXPORT_REASON },
  [OPENALEX_BATCH]: { openWorld: true, reason: 'Queries api.openalex.org; writes nothing.' },
  [OPENALEX_AUTOCOMPLETE]: { openWorld: true, reason: 'Queries api.openalex.org; writes nothing.' },
  [OPENALEX_CONTENT]: {
    idempotent: true,
    openWorld: true,
    reason: 'Downloads from content.openalex.org to a file named by work id and type inside its data dir, replacing a previous download there; a repeat rewrites the same file.',
  },
  [OPENALEX_RATE_LIMIT]: {
    openWorld: true,
    reason: 'Reports in-memory rate-limit state; refresh=true sends one probe request to api.openalex.org.',
  },
};
