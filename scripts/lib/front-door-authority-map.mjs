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

function extractPythonTupleStrings(relPath, symbolName) {
  const source = readRepoFile(relPath);
  const marker = `${symbolName}:`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`${relPath}: missing ${symbolName}`);
  }
  const tupleStart = source.indexOf('(', start);
  if (tupleStart === -1) {
    throw new Error(`${relPath}: missing tuple start for ${symbolName}`);
  }
  const values = [];
  for (const rawLine of source.slice(tupleStart + 1).split('\n')) {
    const line = rawLine.trim();
    if (line === ')') break;
    const match = line.match(/^["']([^"']+)["'],?$/);
    if (match) values.push(match[1]);
  }
  if (values.length === 0) {
    throw new Error(`${relPath}: failed to extract tuple values for ${symbolName}`);
  }
  return Object.freeze(values);
}

function freezeCommands(commands) {
  return Object.freeze(commands.map(command => Object.freeze({ command })));
}

export const FRONT_DOOR_AUTHORITY_CLASSIFICATIONS = Object.freeze([
  'canonical_public',
  'internal_only',
]);

export const AUTORESEARCH_FRONT_DOOR_REL_PATH = 'packages/orchestrator/src/cli-command-inventory.ts';
export const HEP_AUTORESEARCH_INTERNAL_PARSER_REL_PATH = 'packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py';
export const ORCH_EXACT_SPEC_REL_PATH = 'meta/docs/orchestrator-mcp-tools-spec.md';
export const IDEA_MCP_TOOL_REGISTRY_REL_PATH = 'packages/idea-mcp/src/tool-registry.ts';
export const FRONT_DOOR_AUTHORITY_JSON_REL_PATH = 'meta/front_door_authority_map_v1.json';

export const AUTORESEARCH_FRONT_DOOR_COMMANDS = extractTsCommandInventory(AUTORESEARCH_FRONT_DOOR_REL_PATH);

export const AUTORESEARCH_FRONT_DOOR_COMMANDS_MARKDOWN = AUTORESEARCH_FRONT_DOOR_COMMANDS
  .map(command => `\`${command}\``)
  .join(', ');

export const INTERNAL_ONLY_FRONT_DOOR_GROUPS = Object.freeze([
  Object.freeze({
    group: 'legacy_lifecycle_adapters',
    owner: 'internal Python parser keeps thin passthroughs to canonical autoresearch lifecycle',
    commands: freezeCommands(['init', 'status', 'pause', 'resume', 'approve', 'export']),
  }),
  Object.freeze({
    group: 'internal_support_commands',
    owner: 'internal full parser only; maintainer/eval/regression compatibility surface',
    commands: freezeCommands(['branch']),
  }),
  Object.freeze({
    group: 'retired_public_support_commands',
    owner: 'internal full parser only; formerly public support surface now retired from the public front door',
    commands: freezeCommands([
      'method-design',
      'run-card',
    ]),
  }),
  Object.freeze({
    group: 'internal_workflow_paths',
    owner: 'internal full parser only; non-public workflow residue retained for maintainer/eval/regression coverage',
    commands: freezeCommands([
      'run --workflow-id computation',
      'run --workflow-id ingest',
      'run --workflow-id paper_reviser',
      'run --workflow-id reproduce',
      'run --workflow-id revision',
      'run --workflow-id literature_survey_polish',
    ]),
  }),
  Object.freeze({
    group: 'internal_adapter_workflow_paths',
    owner: 'internal full parser only; adapter workflow retained for maintainer/eval/regression coverage',
    commands: freezeCommands(['run --workflow-id shell_adapter_smoke']),
  }),
]);

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
    surface: 'hep_autoresearch_internal_parser',
    classification: 'internal_only',
    owner: 'packages/hep-autoresearch',
    relPath: `${HEP_AUTORESEARCH_INTERNAL_PARSER_REL_PATH}#main`,
    exactInventoryKind: 'group_classification_only',
    groups: INTERNAL_ONLY_FRONT_DOOR_GROUPS,
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
