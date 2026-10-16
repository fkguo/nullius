/**
 * Risk levels and behaviour hints for the pdg-mcp tools, from which
 * `getTools` derives the MCP annotations (rules in @nullius/shared
 * tool-annotations.ts). hep-mcp re-exports these tools and reads these same
 * tables, so both servers list the same hints.
 *
 * Every tool reads only the local PDG SQLite file. The artifact tools write
 * their result under the PDG data dir and return its URI, replacing a file
 * of the same name, and before writing they delete artifacts older than
 * PDG_ARTIFACT_TTL_HOURS; so they may delete caller-visible files, and a
 * later identical call can delete more.
 */

import {
  PDG_BATCH,
  PDG_FIND_PARTICLE,
  PDG_FIND_REFERENCE,
  PDG_GET,
  PDG_GET_DECAYS,
  PDG_GET_MEASUREMENTS,
  PDG_GET_PROPERTY,
  PDG_GET_REFERENCE,
  PDG_INFO,
  type ToolBehaviourHintTable,
  type ToolRiskTable,
} from '@nullius/shared';

const ARTIFACT_REASON =
  'Reads the local PDG database and writes a result artifact, replacing one of the same name; first deletes artifacts older than the TTL.';

export const PDG_TOOL_RISK_LEVELS: ToolRiskTable = {
  [PDG_INFO]: 'read',
  [PDG_FIND_PARTICLE]: 'read',
  [PDG_FIND_REFERENCE]: 'read',
  [PDG_GET_REFERENCE]: 'read',
  [PDG_GET_PROPERTY]: 'read',
  // The next four write a result artifact whose URI they return.
  [PDG_GET]: 'write',
  [PDG_GET_DECAYS]: 'write',
  [PDG_GET_MEASUREMENTS]: 'write',
  [PDG_BATCH]: 'write',
};

export const PDG_TOOL_HINTS: ToolBehaviourHintTable = {
  [PDG_INFO]: { openWorld: false, reason: 'Reports the server version and local data paths.' },
  [PDG_FIND_PARTICLE]: { openWorld: false, reason: 'Queries the local PDG database; writes nothing.' },
  [PDG_FIND_REFERENCE]: { openWorld: false, reason: 'Queries the local PDG database; writes nothing.' },
  [PDG_GET_REFERENCE]: { openWorld: false, reason: 'Queries the local PDG database; returns INSPIRE/DOI ids without calling out.' },
  [PDG_GET_PROPERTY]: { openWorld: false, reason: 'Queries the local PDG database; writes nothing.' },
  [PDG_GET]: { destructive: true, openWorld: false, reason: ARTIFACT_REASON },
  [PDG_GET_DECAYS]: { destructive: true, openWorld: false, reason: ARTIFACT_REASON },
  [PDG_GET_MEASUREMENTS]: { destructive: true, openWorld: false, reason: ARTIFACT_REASON },
  [PDG_BATCH]: {
    destructive: true,
    openWorld: false,
    reason: 'Runs the PDG tools locally (with their artifact replacement and TTL deletion) and writes a batch artifact whose name includes the start time, so each repeat adds a file.',
  },
};
