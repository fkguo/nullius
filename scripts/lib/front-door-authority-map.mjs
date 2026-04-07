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
  'compatibility_public',
  'internal_only',
]);

export const AUTORESEARCH_FRONT_DOOR_REL_PATH = 'packages/orchestrator/src/cli-command-inventory.ts';
export const HEPAR_PUBLIC_SHELL_REL_PATH = 'packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py';
export const ORCH_EXACT_SPEC_REL_PATH = 'meta/docs/orchestrator-mcp-tools-spec.md';
export const FRONT_DOOR_AUTHORITY_JSON_REL_PATH = 'meta/front_door_authority_map_v1.json';

export const AUTORESEARCH_FRONT_DOOR_COMMANDS = extractTsCommandInventory(AUTORESEARCH_FRONT_DOOR_REL_PATH);
export const HEPAR_PUBLIC_SHELL_COMMANDS = extractPythonTupleStrings(
  HEPAR_PUBLIC_SHELL_REL_PATH,
  'PUBLIC_SHELL_COMMANDS',
);

export const AUTORESEARCH_FRONT_DOOR_COMMANDS_MARKDOWN = AUTORESEARCH_FRONT_DOOR_COMMANDS
  .map(command => `\`${command}\``)
  .join(', ');

export const HEPAR_PUBLIC_SHELL_COMMANDS_MARKDOWN = HEPAR_PUBLIC_SHELL_COMMANDS
  .map(command => `\`${command}\``)
  .join(', ');

export const INTERNAL_ONLY_FRONT_DOOR_GROUPS = Object.freeze([
  Object.freeze({
    group: 'legacy_lifecycle_adapters',
    owner: 'installable Python shell keeps only thin passthroughs to canonical autoresearch lifecycle',
    commands: freezeCommands(['init', 'status', 'pause', 'resume', 'approve', 'export']),
  }),
  Object.freeze({
    group: 'internal_support_commands',
    owner: 'internal full parser only; maintainer/eval/regression compatibility surface',
    commands: freezeCommands(['start', 'checkpoint', 'request-approval', 'reject', 'doctor', 'bridge', 'literature-gap']),
  }),
  Object.freeze({
    group: 'internal_workflow_paths',
    owner: 'internal full parser only; non-public workflow residue retained for maintainer/eval/regression coverage',
    commands: freezeCommands([
      'run --workflow-id computation',
      'run --workflow-id ingest',
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
    surface: 'hepar_public_shell',
    classification: 'compatibility_public',
    owner: 'packages/hep-autoresearch',
    relPath: `${HEPAR_PUBLIC_SHELL_REL_PATH}#PUBLIC_SHELL_COMMANDS`,
    exactInventoryKind: 'python_public_shell_tuple',
    commands: freezeCommands(HEPAR_PUBLIC_SHELL_COMMANDS),
  }),
  Object.freeze({
    surface: 'hepar_internal_full_parser',
    classification: 'internal_only',
    owner: 'packages/hep-autoresearch',
    relPath: `${HEPAR_PUBLIC_SHELL_REL_PATH}#main(public_surface=False)`,
    exactInventoryKind: 'group_classification_only',
    groups: INTERNAL_ONLY_FRONT_DOOR_GROUPS,
  }),
  Object.freeze({
    surface: 'orchestrator_mcp_tools_spec',
    classification: 'canonical_public',
    owner: '@autoresearch/hep-mcp',
    relPath: ORCH_EXACT_SPEC_REL_PATH,
    exactInventoryKind: 'exact_spec_doc',
    toolPrefix: 'orch_',
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
