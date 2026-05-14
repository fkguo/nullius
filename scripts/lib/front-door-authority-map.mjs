import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf-8');
}

function extractTsCommandInventory(relPath) {
  const source = readRepoFile(relPath);
  const commands = Array.from(source.matchAll(/\{\s*command:\s*'([^']+)'/g), match => match[1]);
  if (commands.length === 0) {
    throw new Error(`${relPath}: failed to extract TS command inventory`);
  }
  return Object.freeze(commands);
}

function freezeCommands(commands) {
  return Object.freeze(commands.map(command => Object.freeze({ command })));
}

export const FRONT_DOOR_AUTHORITY_CLASSIFICATIONS = Object.freeze([
  'canonical_public',
]);

export const AUTORESEARCH_FRONT_DOOR_REL_PATH = 'packages/orchestrator/src/cli-command-inventory.ts';
export const ORCH_EXACT_SPEC_REL_PATH = 'meta/docs/orchestrator-mcp-tools-spec.md';
export const IDEA_MCP_TOOL_REGISTRY_REL_PATH = 'packages/idea-mcp/src/tool-registry.ts';
export const FRONT_DOOR_AUTHORITY_JSON_REL_PATH = 'meta/front_door_authority_map_v1.json';

export const AUTORESEARCH_FRONT_DOOR_COMMANDS = extractTsCommandInventory(AUTORESEARCH_FRONT_DOOR_REL_PATH);

export const AUTORESEARCH_FRONT_DOOR_COMMANDS_MARKDOWN = AUTORESEARCH_FRONT_DOOR_COMMANDS
  .map(command => `\`${command}\``)
  .join(', ');

export const FRONT_DOOR_AUTHORITY_MAP = Object.freeze([
  Object.freeze({
    surface: 'autoresearch_cli',
    classification: 'canonical_public',
    owner: '@autoresearch/orchestrator',
    relPath: AUTORESEARCH_FRONT_DOOR_REL_PATH,
    exactInventoryKind: 'ts_command_inventory',
    commands: freezeCommands(AUTORESEARCH_FRONT_DOOR_COMMANDS),
  }),
  Object.freeze({
    surface: 'orchestrator_mcp_tools_spec',
    classification: 'canonical_public',
    owner: '@autoresearch/orchestrator',
    relPath: ORCH_EXACT_SPEC_REL_PATH,
    exactInventoryKind: 'exact_spec_doc',
    toolPrefix: 'orch_',
    driftTestSource: 'packages/orchestrator/tests/orchestrator-mcp-tools-spec.test.ts',
  }),
  Object.freeze({
    surface: 'idea_mcp',
    classification: 'canonical_public',
    owner: '@autoresearch/idea-mcp',
    relPath: IDEA_MCP_TOOL_REGISTRY_REL_PATH,
    exactInventoryKind: 'mcp_tool_inventory',
  }),
]);

export const FRONT_DOOR_AUTHORITY_MAP_BY_SURFACE = Object.freeze(
  Object.fromEntries(FRONT_DOOR_AUTHORITY_MAP.map(entry => [entry.surface, entry])),
);

const FRONT_DOOR_AUTHORITY_JSON = Object.freeze(JSON.parse(readRepoFile(FRONT_DOOR_AUTHORITY_JSON_REL_PATH)));

export const FRONT_DOOR_AUTHORITY_SURFACE_IDS = Object.freeze(
  Object.keys(FRONT_DOOR_AUTHORITY_JSON.surfaces ?? {}),
);

export function getFrontDoorAuthoritySurface(surfaceId) {
  const surface = FRONT_DOOR_AUTHORITY_JSON.surfaces?.[surfaceId];
  if (!surface) {
    throw new Error(`unknown front-door authority surface: ${surfaceId}`);
  }
  return surface;
}
