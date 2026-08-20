import { types as nodeTypes } from 'node:util';

import type { ToolUseContent } from './backends/chat-backend.js';
import { canonicalJson } from './run-manifest.js';
import {
  assertToolCallAllowed,
  isParallelBatchSafeToolExecutionPolicy,
  type ToolExecutionPolicy,
  type ToolPermissionView,
} from './tool-execution-policy.js';

export interface FrozenToolUseExecution {
  readonly toolUse: ToolUseContent;
  readonly executionPolicy: Readonly<ToolExecutionPolicy>;
}

export type FrozenToolUseExecutionGroup = ReadonlyArray<FrozenToolUseExecution>;

function snapshotError(location: string, reason: string): Error {
  return new Error(`Tool-use snapshot rejected ${location}: ${reason}.`);
}

function assertPlainNonProxyObject(value: object, location: string): void {
  if (nodeTypes.isProxy(value)) {
    throw snapshotError(location, 'Proxy values are not allowed');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw snapshotError(location, 'only plain objects are allowed');
  }
}

function requireDataDescriptor(
  descriptors: { readonly [key: string]: PropertyDescriptor | undefined },
  key: string,
  location: string,
): PropertyDescriptor & { value: unknown } {
  const descriptor = descriptors[key];
  if (!descriptor) {
    throw snapshotError(location, 'the property is missing');
  }
  if (Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set')) {
    throw snapshotError(location, 'accessor properties are not allowed');
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw snapshotError(location, 'the property is not a data property');
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

function snapshotJsonValue(value: unknown, location: string, active: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw snapshotError(location, 'non-finite numbers are not valid JSON');
    }
    // JSON canonicalization erases negative zero; normalize it now so the
    // dispatched value and its manifest identity cannot disagree.
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw snapshotError(location, `${typeof value} values are not valid JSON`);
  }
  if (nodeTypes.isProxy(value)) {
    throw snapshotError(location, 'Proxy values are not allowed');
  }
  if (active.has(value)) {
    throw snapshotError(location, 'cyclic values are not valid JSON');
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw snapshotError(location, 'only ordinary arrays are allowed');
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key === 'symbol')) {
        throw snapshotError(location, 'symbol properties are not valid JSON');
      }
      const lengthDescriptor = requireDataDescriptor(descriptors, 'length', `${location}.length`);
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        throw snapshotError(`${location}.length`, 'the array length is invalid');
      }
      const indexKeys = (keys as string[]).filter(key => key !== 'length');
      if (indexKeys.length !== length) {
        throw snapshotError(location, 'sparse arrays are not valid stable snapshots');
      }

      const snapshot: unknown[] = new Array(length as number);
      for (const key of indexKeys) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= (length as number) || String(index) !== key) {
          throw snapshotError(`${location}.${key}`, 'non-index array properties are not allowed');
        }
        const descriptor = requireDataDescriptor(descriptors, key, `${location}[${key}]`);
        snapshot[index] = snapshotJsonValue(descriptor.value, `${location}[${key}]`, active);
      }
      return Object.freeze(snapshot);
    }

    assertPlainNonProxyObject(value, location);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key === 'symbol')) {
      throw snapshotError(location, 'symbol properties are not valid JSON');
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of (keys as string[]).sort()) {
      const descriptor = requireDataDescriptor(descriptors, key, `${location}.${key}`);
      if (!descriptor.enumerable) {
        throw snapshotError(`${location}.${key}`, 'non-enumerable properties are not valid JSON data');
      }
      Object.defineProperty(snapshot, key, {
        value: snapshotJsonValue(descriptor.value, `${location}.${key}`, active),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(snapshot);
  } finally {
    active.delete(value);
  }
}

export function snapshotJsonExecutionValue(value: unknown, location: string): unknown {
  return snapshotJsonValue(value, location, new Set<object>());
}

function snapshotToolUse(source: ToolUseContent): ToolUseContent {
  if (!source || typeof source !== 'object') {
    throw snapshotError('tool use', 'a plain object is required');
  }
  assertPlainNonProxyObject(source, 'tool use');
  const descriptors = Object.getOwnPropertyDescriptors(source);
  const keys = Reflect.ownKeys(descriptors);
  const expectedKeys = new Set(['type', 'id', 'name', 'input']);
  if (keys.some(key => typeof key === 'symbol' || !expectedKeys.has(key))) {
    throw snapshotError('tool use', 'only type, id, name, and input data properties are allowed');
  }
  if (keys.length !== expectedKeys.size) {
    throw snapshotError('tool use', 'type, id, name, and input are all required');
  }

  const typeDescriptor = requireDataDescriptor(descriptors, 'type', 'tool use.type');
  const idDescriptor = requireDataDescriptor(descriptors, 'id', 'tool use.id');
  const nameDescriptor = requireDataDescriptor(descriptors, 'name', 'tool use.name');
  const inputDescriptor = requireDataDescriptor(descriptors, 'input', 'tool use.input');
  for (const [key, descriptor] of [
    ['type', typeDescriptor],
    ['id', idDescriptor],
    ['name', nameDescriptor],
    ['input', inputDescriptor],
  ] as const) {
    if (!descriptor.enumerable) {
      throw snapshotError(`tool use.${key}`, 'non-enumerable properties are not allowed');
    }
  }

  const type = typeDescriptor.value;
  const id = idDescriptor.value;
  const name = nameDescriptor.value;
  const input = inputDescriptor.value;
  if (type !== 'tool_use') throw snapshotError('tool use.type', 'the value must be tool_use');
  if (typeof id !== 'string' || !id.trim()) throw snapshotError('tool use.id', 'a non-empty string is required');
  if (typeof name !== 'string' || !name.trim()) throw snapshotError('tool use.name', 'a non-empty string is required');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw snapshotError('tool use.input', 'a plain JSON object is required');
  }

  const inputSnapshot = snapshotJsonExecutionValue(input, 'tool use.input');
  const snapshot = Object.freeze({
    type: 'tool_use' as const,
    id,
    name,
    input: inputSnapshot as Record<string, unknown>,
  });
  // Keep this boundary aligned with the manifest hashing contract. This is an
  // assertion over the detached copy; no model-owned object is re-read here.
  canonicalJson(snapshot);
  return snapshot;
}

function snapshotToolUseList(toolUses: ReadonlyArray<ToolUseContent>): ToolUseContent[] {
  if (nodeTypes.isProxy(toolUses)) {
    throw snapshotError('tool-use list', 'Proxy values are not allowed');
  }
  if (!Array.isArray(toolUses) || Object.getPrototypeOf(toolUses) !== Array.prototype) {
    throw snapshotError('tool-use list', 'an ordinary array is required');
  }
  const descriptors = Object.getOwnPropertyDescriptors(toolUses);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key === 'symbol')) {
    throw snapshotError('tool-use list', 'symbol properties are not allowed');
  }
  const lengthDescriptor = requireDataDescriptor(descriptors, 'length', 'tool-use list.length');
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw snapshotError('tool-use list.length', 'the array length is invalid');
  }
  const indexKeys = (keys as string[]).filter(key => key !== 'length');
  if (indexKeys.length !== length) {
    throw snapshotError('tool-use list', 'the list must be dense and contain no extra properties');
  }
  const snapshots: ToolUseContent[] = new Array(length as number);
  for (const key of indexKeys) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= (length as number) || String(index) !== key) {
      throw snapshotError(`tool-use list.${key}`, 'non-index properties are not allowed');
    }
    snapshots[index] = snapshotToolUse(
      requireDataDescriptor(descriptors, key, `tool-use list[${key}]`).value as ToolUseContent,
    );
  }
  return snapshots;
}

export function groupToolUsesForExecution(
  toolUses: ReadonlyArray<ToolUseContent>,
  permissionView: ToolPermissionView,
): ReadonlyArray<FrozenToolUseExecutionGroup> {
  // Resolve every authorization and policy before returning any executable
  // group. Callers therefore cannot dispatch a permitted prefix when a later
  // tool use in the same model response is denied.
  const prepared = snapshotToolUseList(toolUses).map((toolUse): FrozenToolUseExecution => Object.freeze({
    toolUse,
    executionPolicy: Object.freeze({ ...assertToolCallAllowed(toolUse.name, permissionView) }),
  }));

  const groups: FrozenToolUseExecutionGroup[] = [];
  let batchSafeGroup: FrozenToolUseExecution[] = [];

  const flushBatchSafeGroup = () => {
    if (batchSafeGroup.length === 0) {
      return;
    }
    groups.push(Object.freeze(batchSafeGroup));
    batchSafeGroup = [];
  };

  for (const execution of prepared) {
    if (isParallelBatchSafeToolExecutionPolicy(execution.executionPolicy)) {
      batchSafeGroup.push(execution);
      continue;
    }
    flushBatchSafeGroup();
    groups.push(Object.freeze([execution]));
  }

  flushBatchSafeGroup();
  return Object.freeze(groups);
}
