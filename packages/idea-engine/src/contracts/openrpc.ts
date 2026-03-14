import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

interface OpenRpcParam {
  name: string;
  required?: boolean;
  schema?: {
    default?: unknown;
  };
}

interface OpenRpcMethod {
  name: string;
  params?: OpenRpcParam[];
}

interface OpenRpcDocument {
  methods?: OpenRpcMethod[];
}

export const DEFAULT_CONTRACT_DIR = fileURLToPath(
  new URL('../../../idea-core/contracts/idea-generator-snapshot/schemas', import.meta.url),
);

const OPENRPC_PATH = resolve(DEFAULT_CONTRACT_DIR, 'idea_core_rpc_v1.openrpc.json');

function loadOpenRpcDocument(): OpenRpcDocument {
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
