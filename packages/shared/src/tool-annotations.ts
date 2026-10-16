/**
 * MCP tool annotations derived from the provider's risk classification.
 *
 * The MCP spec gives absent hints the most cautious values (readOnlyHint
 * false, destructiveHint true, idempotentHint false, openWorldHint true), so
 * a tool listed without annotations is shown to hosts as "may destroy data
 * and reaches external services". Each provider states the facts once — its
 * risk table plus one behaviour-hint entry per tool — and this helper turns
 * them into the four hints by fixed rules:
 *
 * - readOnlyHint = risk is 'read'. A read creates or changes no file or
 *   record the caller can see; internal bookkeeping (HTTP or source caches,
 *   rate-limit state, staging that is removed again) is not a write.
 * - destructiveHint = risk is 'destructive', i.e. the tool may replace or
 *   delete existing data. Writes that only add new data are 'write' and
 *   report false; so does a write that only rewrites its own regenerable
 *   output at a path fixed by its arguments. Reads report false. A tool whose
 *   own confirmation protocol (a preview token) already gates a delete keeps
 *   risk 'write', since 'destructive' would add the dispatcher's `_confirm`
 *   gate on top; its entry sets `destructive: true`, which can only raise the
 *   hint, never lower it.
 * - idempotentHint = true for every read. A write or destructive tool is
 *   idempotent only when the entry says so: the call is keyed by an
 *   idempotency or delivery id whose replay returns the original response,
 *   or it writes the same artifact for the same arguments, so repeating it
 *   has no further effect.
 * - openWorldHint = the tool calls services outside this machine (INSPIRE,
 *   arXiv, OpenAlex, HEPData, CrossRef) or writes into the user's Zotero
 *   library, which the Zotero app may sync to zotero.org and shared groups;
 *   false for tools confined to local data (a local SQLite database, the idea
 *   store, the bound project, Zotero local-API reads).
 *
 * Hints are advisory for hosts, never a security boundary; gating such as
 * `_confirm` stays with the provider's dispatcher.
 */

import type { ToolRiskLevel, ToolRiskTable } from './tool-risk.js';

export interface ToolBehaviourHints {
  /**
   * Repeating the call with identical arguments has no further effect.
   * Ignored for reads, which are always idempotent.
   */
  idempotent?: boolean;
  /**
   * The tool may delete or replace data although its risk level is 'write'
   * (see the module comment). Ignored for reads.
   */
  destructive?: boolean;
  /** The tool calls services outside this machine. */
  openWorld: boolean;
  /** One line stating the evidence for these hints. */
  reason: string;
}

export type ToolBehaviourHintTable = Readonly<Record<string, ToolBehaviourHints>>;

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export function riskToAnnotations(risk: ToolRiskLevel, hints: ToolBehaviourHints): McpToolAnnotations {
  const readOnly = risk === 'read';
  return {
    readOnlyHint: readOnly,
    destructiveHint: risk === 'destructive' || (!readOnly && hints.destructive === true),
    idempotentHint: readOnly || hints.idempotent === true,
    openWorldHint: hints.openWorld,
  };
}

/**
 * Annotations for one tool from the provider's tables. A tool missing from
 * either table is an error, so a new tool cannot be listed with guessed hints.
 */
export function toolAnnotationsFor(
  toolName: string,
  riskTable: ToolRiskTable,
  hintTable: ToolBehaviourHintTable,
): McpToolAnnotations {
  if (!Object.prototype.hasOwnProperty.call(riskTable, toolName)) {
    throw new Error(`No risk level recorded for tool ${toolName}`);
  }
  if (!Object.prototype.hasOwnProperty.call(hintTable, toolName)) {
    throw new Error(`No behaviour hints recorded for tool ${toolName}`);
  }
  return riskToAnnotations(riskTable[toolName]!, hintTable[toolName]!);
}

/**
 * `structuredContent` for a result whose text block is `JSON.stringify(result)`:
 * the result itself when it serialises as a JSON object (the spec requires an
 * object), otherwise undefined so the caller returns the text block alone.
 * A value with its own `toJSON` (e.g. a Date) is left out: it does not
 * serialise as the object it is.
 */
export function structuredContentOf(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined;
  if (typeof (result as { toJSON?: unknown }).toJSON === 'function') return undefined;
  return result as Record<string, unknown>;
}
