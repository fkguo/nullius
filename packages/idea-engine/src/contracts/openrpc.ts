import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

export interface OpenRpcParam {
  name: string;
  required?: boolean;
  schema?: {
    default?: unknown;
  };
}

export interface OpenRpcMethod {
  name: string;
  params?: OpenRpcParam[];
  result?: {
    schema?: Record<string, unknown>;
  };
}

export interface OpenRpcDocument {
  methods?: OpenRpcMethod[];
  info?: {
    version?: string;
  };
  ['x-error-data-contract']?: {
    schema?: Record<string, unknown>;
  };
}

// idea-engine owns the runtime-default contract snapshot locally.
export const DEFAULT_CONTRACT_DIR = fileURLToPath(
  new URL('../../contracts/idea-runtime-contracts/schemas', import.meta.url),
);

export const OPENRPC_PATH = resolve(DEFAULT_CONTRACT_DIR, 'idea_core_rpc_v1.openrpc.json');

export function loadOpenRpcDocument(): OpenRpcDocument {
  return JSON.parse(readFileSync(OPENRPC_PATH, 'utf8')) as OpenRpcDocument;
}

const OPENRPC_DOCUMENT = loadOpenRpcDocument();
const METHOD_MAP = new Map(
  (OPENRPC_DOCUMENT.methods ?? []).map(method => [method.name, method] as const),
);

export function getMethodContract(method: string): OpenRpcMethod | undefined {
  return METHOD_MAP.get(method);
}

export function getMethodDefault(method: string, paramName: string): unknown {
  const contract = getMethodContract(method);
  const param = contract?.params?.find(candidate => candidate.name === paramName);
  return param?.schema?.default;
}
