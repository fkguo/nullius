import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import Ajv2020 from 'ajv/dist/2020.js';
import { DEFAULT_CONTRACT_DIR, type OpenRpcMethod, type OpenRpcDocument } from './openrpc.js';

type AjvValidator = ((value: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string }>;
};

type AjvInstance = {
  addFormat: (name: string, validate: (value: string) => boolean) => void;
  addSchema: (schema: Record<string, unknown>, key?: string) => void;
  compile: (schema: Record<string, unknown>) => AjvValidator;
};

type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

const Ajv2020Ctor = Ajv2020 as unknown as AjvConstructor;

export class ContractRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractRuntimeError';
  }
}

function formatValidationError(errors: AjvValidator['errors']): string {
  const first = errors?.[0];
  if (!first) {
    return "schema_invalid at '<root>': validation failed";
  }
  const location = first.instancePath ? first.instancePath.slice(1) || '<root>' : '<root>';
  return `schema_invalid at '${location}': ${first.message ?? 'validation failed'}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDateTime(value: string): boolean {
  return typeof value === 'string' && value.includes('T') && !Number.isNaN(Date.parse(value));
}

function isUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 0;
  } catch {
    return false;
  }
}

export class IdeaEngineContractCatalog {
  readonly contractDir: string;
  readonly contractVersion: string;
  private readonly ajv: AjvInstance;
  private readonly methods = new Map<string, OpenRpcMethod>();
  private readonly openrpcUri: string;
  private readonly errorDataSchema?: Record<string, unknown>;

  constructor(contractDir = DEFAULT_CONTRACT_DIR) {
    this.contractDir = resolve(contractDir);
    const openrpcPath = resolve(this.contractDir, 'idea_core_rpc_v1.openrpc.json');
    this.openrpcUri = pathToFileURL(openrpcPath).href;
    const openrpc = JSON.parse(readFileSync(openrpcPath, 'utf8')) as OpenRpcDocument;
    this.contractVersion = String(openrpc.info?.version ?? 'unknown');
    this.ajv = new Ajv2020Ctor({
      allErrors: true,
      strict: false,
      validateFormats: true,
      addUsedSchema: false,
    });
    this.ajv.addFormat('uuid', isUuid);
    this.ajv.addFormat('date-time', isDateTime);
    this.ajv.addFormat('uri', isUri);
    this.loadSchemas();

    for (const method of openrpc.methods ?? []) {
      this.methods.set(method.name, method);
    }
    this.errorDataSchema = openrpc['x-error-data-contract']?.schema;
  }

  validateRequestParams(methodName: string, params: unknown): void {
    const method = this.methods.get(methodName);
    if (!method) {
      throw new ContractRuntimeError(`unknown method contract: ${methodName}`);
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new ContractRuntimeError('params must be an object (by-name)');
    }

    const record = params as Record<string, unknown>;
    const required = new Set((method.params ?? []).filter(param => param.required).map(param => param.name));
    const missing = [...required].filter(name => !(name in record));
    if (missing.length > 0) {
      throw new ContractRuntimeError(`missing required params: ${missing.join(', ')}`);
    }

    const allowed = new Set((method.params ?? []).map(param => param.name));
    const extras = Object.keys(record).filter(name => !allowed.has(name));
    if (extras.length > 0) {
      throw new ContractRuntimeError(`unknown params: ${extras.join(', ')}`);
    }

    for (const param of method.params ?? []) {
      if (!(param.name in record) || !param.schema || typeof param.schema !== 'object') {
        continue;
      }
      this.validateWithSchema(
        param.schema as Record<string, unknown>,
        record[param.name],
        this.scopedUri(`${methodName}/params/${param.name}`),
      );
    }
  }

  validateResult(methodName: string, result: unknown): void {
    const method = this.methods.get(methodName);
    if (!method?.result?.schema || typeof method.result.schema !== 'object') {
      throw new ContractRuntimeError(`unknown result contract: ${methodName}`);
    }
    this.validateWithSchema(method.result.schema, result, this.scopedUri(`${methodName}/result`));
  }

  validateAgainstRef(ref: string, instance: unknown, baseName: string): void {
    this.validateWithSchema({ $ref: ref }, instance, this.scopedUri(baseName));
  }

  validateErrorData(errorData: Record<string, unknown>): void {
    if (!this.errorDataSchema) {
      return;
    }
    this.validateWithSchema(this.errorDataSchema, errorData, this.scopedUri('x-error-data-contract/schema'));
  }

  private loadSchemas(): void {
    for (const entry of readdirSync(this.contractDir).filter(name => name.endsWith('.schema.json')).sort()) {
      const path = resolve(this.contractDir, entry);
      const schema = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      this.ajv.addSchema({ ...schema, $id: pathToFileURL(path).href }, pathToFileURL(path).href);
    }
  }

  private validateWithSchema(schema: Record<string, unknown>, instance: unknown, baseUri: string): void {
    const validator = this.ajv.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: baseUri,
      ...schema,
    });
    if (!validator(instance)) {
      throw new ContractRuntimeError(formatValidationError(validator.errors));
    }
  }

  private scopedUri(scope: string): string {
    return `${this.openrpcUri}?scope=${encodeURIComponent(scope)}`;
  }
}
