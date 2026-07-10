import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { OPENRPC_PATH } from '../src/contracts/openrpc.js';

// Registry-honesty tripwire: every error.data.reason the service layer throws with one of
// TARGET_CODES must be listed under that code in the OpenRPC contract's
// x-error-data-contract.known_reasons registry. The scan is textual and fail-closed on
// every construction shape it recognizes: a site it cannot resolve to reason string
// literals fails the test, as do RpcError aliasing/subclassing and subdirectories under
// src/service, so drift toward unrecognized idioms is loud instead of silent.
//
// Recognized shapes (the only ones the service layer currently uses):
//   1. new RpcError(<code>, msg, { reason: '<literal>', ... })              — inline literal
//   2. const data = { reason: '<literal>', ... }; new RpcError(<code>, msg, data)
//      — nearest reason above the construction site, within a small window
//   3. helper(reason, ...) forwarding a parameter into new RpcError(<code>, ...)
//      — string-literal first argument at every call site
//   4. helper({ ..., reason: '<literal>' }) forwarding options.reason
//      — reason literal inside every call span
// A helper that spreads caller extras after an inline reason literal (shape 1 plus `...`)
// additionally has its call sites checked for literal overrides.
//
// Residual limits, stated honestly rather than assumed away: the shape-2 backward window
// takes the nearest reason literal within BACKWARD_WINDOW_LINES lines above the
// construction site, so an interposed unrelated `reason: '<literal>'` line could in
// principle be mis-associated; the span extractor understands strings, template literals
// (with nested ${...}), and comments, but not regex literals; constructions routed
// through code outside src/service are beyond this scan's sight. Construction sites
// visible in these files that fall outside the recognized shapes fail loudly
// (unbalanced span / unresolved site / alias and directory tripwires).

// -32018 is not thrown anywhere yet: it is scanned pre-emptively so the registry check
// engages the moment the first -32018 reason lands in the service layer.
const TARGET_CODES = new Set([-32002, -32016, -32017, -32018]);
const BACKWARD_WINDOW_LINES = 12;

const SERVICE_DIR = fileURLToPath(new URL('../src/service', import.meta.url));

interface SourceFile {
  name: string;
  text: string;
}

interface HarvestedReason {
  code: number;
  reason: string;
  site: string;
}

function loadServiceSources(): SourceFile[] {
  const entries = readdirSync(SERVICE_DIR, { withFileTypes: true });
  const subdirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  if (subdirs.length > 0) {
    throw new Error(
      `src/service now has subdirectories (${subdirs.join(', ')}); this scan reads the flat directory only — extend it to recurse`,
    );
  }
  const oddities = entries.filter(entry => !entry.isFile() && !entry.isDirectory()).map(entry => entry.name);
  if (oddities.length > 0) {
    throw new Error(
      `src/service contains non-regular entries (${oddities.join(', ')}) — e.g. symlinks — that this scan would silently skip; resolve them or extend it`,
    );
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => entry.name)
    .sort()
    .map(name => ({ name, text: readFileSync(resolve(SERVICE_DIR, name), 'utf8') }));
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function skipStringLiteral(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error(`unterminated ${quote}-string starting at index ${start}`);
}

/**
 * Return the balanced `(...)` span starting at text[openParen] === '(', skipping over
 * string literals, template literals (including nested ${...} code), and comments so that
 * parentheses and braces inside them never disturb the balance.
 */
function extractCallSpan(text: string, openParen: number): string {
  if (text[openParen] !== '(') {
    throw new Error(`expected '(' at index ${openParen}`);
  }
  type Frame = { mode: 'code'; braces: number } | { mode: 'template' };
  const stack: Frame[] = [{ mode: 'code', braces: 0 }];
  let parens = 0;
  let i = openParen;
  while (i < text.length) {
    const frame = stack[stack.length - 1];
    const ch = text[i];
    const next = text[i + 1];
    if (frame.mode === 'template') {
      if (ch === '\\') {
        i += 2;
      } else if (ch === '`') {
        stack.pop();
        i += 1;
      } else if (ch === '$' && next === '{') {
        stack.push({ mode: 'code', braces: 0 });
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipStringLiteral(text, i, ch);
    } else if (ch === '`') {
      stack.push({ mode: 'template' });
      i += 1;
    } else if (ch === '/' && next === '/') {
      const newline = text.indexOf('\n', i);
      if (newline < 0) break;
      i = newline;
    } else if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 2;
    } else if (ch === '(') {
      parens += 1;
      i += 1;
    } else if (ch === ')') {
      parens -= 1;
      i += 1;
      if (parens === 0) return text.slice(openParen, i);
    } else if (ch === '{') {
      frame.braces += 1;
      i += 1;
    } else if (ch === '}') {
      if (frame.braces === 0 && stack.length > 1) {
        stack.pop(); // end of a ${...} substitution
      } else {
        frame.braces -= 1;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  throw new Error(`unbalanced call span starting at index ${openParen}`);
}

interface ReasonToken {
  index: number;
  kind: 'literal' | 'dynamic';
  literal?: string;
}

/**
 * Find `reason` property/shorthand tokens in a text fragment and classify them:
 * `reason: '<snake_case>'` is a literal (unless part of a string-literal union type);
 * `reason,` / `reason }` shorthands and `reason: <expr>` are dynamic. Member accesses
 * like `options.reason` in value position are excluded by the lookbehind.
 */
function reasonTokensIn(text: string): ReasonToken[] {
  const tokens: ReasonToken[] = [];
  for (const match of text.matchAll(/(?<![.\w'])reason\b/g)) {
    const index = match.index ?? 0;
    const rest = text.slice(index + 'reason'.length);
    if (/^\s*[,}]/.test(rest)) {
      tokens.push({ index, kind: 'dynamic' });
      continue;
    }
    const colon = rest.match(/^\s*:\s*/);
    if (!colon) continue; // prose in a comment or some non-property use
    const value = rest.slice(colon[0].length);
    const literal = value.match(/^'([A-Za-z0-9_]+)'/);
    if (literal && !/^\s*\|/.test(value.slice(literal[0].length))) {
      tokens.push({ index, kind: 'literal', literal: literal[1] });
    } else {
      // Non-literal value, or a string-literal union in a type annotation: never harvest
      // it as a thrown reason; resolution must go through call sites instead.
      tokens.push({ index, kind: 'dynamic' });
    }
  }
  return tokens;
}

/**
 * Name of the `function <name>(` declaration enclosing `index`, with a crude but
 * fail-closed containment check: after skipping the (possibly multi-line) parameter
 * list, a column-0 `}` between the body's opening brace and `index` means the
 * declaration already ended, so the site is not inside it. Exact for the top-level
 * function declarations the service layer uses; anything fancier fails loudly.
 */
function enclosingFunctionName(file: SourceFile, index: number): string {
  const head = file.text.slice(0, index);
  const decls = [...head.matchAll(/function\s+(\w+)\s*\(/g)];
  const last = decls[decls.length - 1];
  const site = `${file.name}:${lineOf(file.text, index)}`;
  if (!last) {
    throw new Error(`${site}: dynamic reason outside a named function; extend the scanner`);
  }
  const paramsOpen = (last.index ?? 0) + last[0].length - 1;
  const afterParams = paramsOpen + extractCallSpan(file.text, paramsOpen).length;
  const bodyOpen = file.text.indexOf('{', afterParams);
  if (bodyOpen < 0 || bodyOpen >= index || /^\}/m.test(file.text.slice(bodyOpen + 1, index))) {
    throw new Error(
      `${site}: dynamic reason not inside the nearest 'function ${last[1]}(' declaration; extend the scanner`,
    );
  }
  return last[1];
}

/**
 * Harvest reason literals from every call site of a helper whose construction site
 * forwards a caller-supplied reason (requireReason: true — each call must contribute
 * exactly one literal) or spreads caller extras over an inline literal reason
 * (requireReason: false — calls may carry no override, but any override must be literal).
 */
function harvestHelperCallSites(
  files: SourceFile[],
  helperName: string,
  code: number,
  requireReason: boolean,
  sink: HarvestedReason[],
): void {
  const callPattern = new RegExp(`(?<!function\\s)\\b${helperName}\\s*\\(`, 'g');
  let callSites = 0;
  for (const file of files) {
    for (const match of file.text.matchAll(callPattern)) {
      const index = match.index ?? 0;
      const site = `${file.name}:${lineOf(file.text, index)}`;
      const span = extractCallSpan(file.text, index + match[0].length - 1);
      callSites += 1;
      if (requireReason) {
        // Only reason-forwarding helpers take the reason as their first positional
        // argument; in override-check mode the first argument is a detail message.
        const firstArg = span.match(/^\(\s*'([A-Za-z0-9_]+)'/);
        if (firstArg) {
          sink.push({ code, reason: firstArg[1], site });
          continue;
        }
      }
      const tokens = reasonTokensIn(span);
      if (tokens.some(token => token.kind === 'dynamic')) {
        throw new Error(`${site}: ${helperName}(...) forwards a non-literal reason; extend the scanner`);
      }
      const literals = tokens.filter(token => token.kind === 'literal');
      if (literals.length === 1) {
        sink.push({ code, reason: literals[0].literal as string, site });
        continue;
      }
      if (literals.length > 1) {
        throw new Error(`${site}: ambiguous — multiple reason literals in one ${helperName}(...) call`);
      }
      if (requireReason) {
        throw new Error(`${site}: ${helperName}(...) call carries no reason literal for code ${code}`);
      }
    }
  }
  if (requireReason && callSites === 0) {
    throw new Error(`${helperName}: no call sites found for dynamic-reason helper (code ${code})`);
  }
}

/** Nearest reason token strictly above `index`, within BACKWARD_WINDOW_LINES lines. */
function nearestReasonAbove(text: string, index: number): ReasonToken | undefined {
  let windowStart = index;
  for (let lines = 0; lines <= BACKWARD_WINDOW_LINES && windowStart > 0; ) {
    windowStart -= 1;
    if (text[windowStart] === '\n') lines += 1;
  }
  const tokens = reasonTokensIn(text.slice(windowStart, index));
  return tokens[tokens.length - 1];
}

// Aliasing or subclassing RpcError would let constructions escape the textual
// `new RpcError(` scan below, so its absence is itself asserted (assignment alias,
// import/export rename, subclassing, destructuring rename).
const RPC_ERROR_ALIAS = /=\s*RpcError\b|\bRpcError\s+as\b|\bextends\s+RpcError\b|\bRpcError\s*:/;

function harvestThrownReasons(files: SourceFile[]): HarvestedReason[] {
  const harvested: HarvestedReason[] = [];
  for (const file of files) {
    if (RPC_ERROR_ALIAS.test(file.text)) {
      throw new Error(
        `${file.name}: RpcError is aliased or subclassed; this scan only understands direct 'new RpcError(' constructions — extend the scanner`,
      );
    }
    for (const match of file.text.matchAll(/new\s+RpcError\s*\(/g)) {
      const index = match.index ?? 0;
      const site = `${file.name}:${lineOf(file.text, index)}`;
      const span = extractCallSpan(file.text, index + match[0].length - 1);
      const codeMatch = span.match(/^\(\s*(-?\d+)\s*,/);
      if (!codeMatch) {
        throw new Error(`${site}: first argument of new RpcError(...) is not an integer literal; extend the scanner`);
      }
      const code = Number(codeMatch[1]);
      if (!TARGET_CODES.has(code)) continue;

      const spanTokens = reasonTokensIn(span);
      if (spanTokens.length > 0) {
        const nearest = spanTokens[0];
        if (nearest.kind === 'literal') {
          harvested.push({ code, reason: nearest.literal as string, site });
          if (span.includes('...')) {
            // Caller extras are spread over the inline reason: callers may override it.
            const helperName = enclosingFunctionName(file, index);
            harvestHelperCallSites(files, helperName, code, false, harvested);
          }
        } else {
          const helperName = enclosingFunctionName(file, index);
          harvestHelperCallSites(files, helperName, code, true, harvested);
        }
        continue;
      }

      const above = nearestReasonAbove(file.text, index);
      if (!above) {
        throw new Error(`${site}: cannot determine error.data.reason for code ${code}; extend the scanner`);
      }
      if (above.kind === 'literal') {
        harvested.push({ code, reason: above.literal as string, site });
      } else {
        const helperName = enclosingFunctionName(file, index);
        harvestHelperCallSites(files, helperName, code, true, harvested);
      }
    }
  }
  return harvested;
}

let cachedHarvest: HarvestedReason[] | undefined;
function harvestedReasons(): HarvestedReason[] {
  if (!cachedHarvest) cachedHarvest = harvestThrownReasons(loadServiceSources());
  return cachedHarvest;
}

function knownReasons(): Record<string, string[]> {
  const openrpc = JSON.parse(readFileSync(OPENRPC_PATH, 'utf8')) as {
    'x-error-data-contract'?: { known_reasons?: Record<string, string[]> };
  };
  return openrpc['x-error-data-contract']?.known_reasons ?? {};
}

describe('error reason registry', () => {
  it('lists every reason the service layer throws for registry-tracked codes', () => {
    const registry = knownReasons();
    const missing = [
      ...new Set(
        harvestedReasons()
          .filter(entry => !(registry[String(entry.code)] ?? []).includes(entry.reason))
          .map(entry => `${entry.code} ${entry.reason} (thrown at ${entry.site})`),
      ),
    ].sort();
    expect(missing).toEqual([]);
  });

  it('keeps resolving every throw idiom the service layer uses (scanner canaries)', () => {
    const byCode = new Map<number, Set<string>>();
    for (const entry of harvestedReasons()) {
      const bucket = byCode.get(entry.code) ?? new Set<string>();
      bucket.add(entry.reason);
      byCode.set(entry.code, bucket);
    }
    const schemaReasons = [...(byCode.get(-32002) ?? [])];
    // inline literal (+ spread-override check on schemaValidationError)
    expect(schemaReasons).toContain('schema_invalid');
    // data object built before the throw (idempotency conflict)
    expect(schemaReasons).toContain('idempotency_key_conflict');
    // helper forwarding a reason parameter (import-generated semantic validation)
    expect(schemaReasons).toContain('anchor_missing');
    // options-object helper (promotion blocked; the lifecycle state machine
    // renamed node_not_active -> node_not_admitted)
    expect([...(byCode.get(-32017) ?? [])]).toEqual(
      expect.arrayContaining(['posterior_missing', 'node_not_admitted']),
    );
    // options-object helper behind a data variable (reduction audit)
    expect([...(byCode.get(-32016) ?? [])]).toEqual(
      expect.arrayContaining([
        'reduction_audit_not_pass',
        'reduction_audit_missing',
        'abstract_problem_not_in_registry',
      ]),
    );
  });
});
