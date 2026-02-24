import { latexParser } from 'latex-utensils';
import type * as LU from 'latex-utensils';

type LatexNode = LU.latexParser.Node;

export interface StringifyLatexOptions {
  /**
   * When true, throw on unhandled node kinds instead of dropping them.
   * Use this in unit tests to prevent silent regressions.
   */
  strict?: boolean;
  /** Protect against pathological recursion. */
  maxDepth?: number;
}

const DEFAULT_OPTIONS: Required<StringifyLatexOptions> = {
  strict: false,
  maxDepth: 200,
};

function cmdNameFromKind(kind: string): string | null {
  if (!kind.startsWith('command.')) return null;
  return kind.slice('command.'.length);
}

function isNodeLike(value: unknown): value is LatexNode {
  return Boolean(value) && typeof value === 'object' && 'kind' in (value as any);
}

function throwUnhandled(node: LatexNode): never {
  const keys = Object.keys(node as any).sort().join(', ');
  throw new Error(`Unhandled LaTeX AST node kind "${(node as any).kind}" (keys: ${keys})`);
}

function formatArg(arg: LatexNode, options: Required<StringifyLatexOptions>, depth: number): string {
  if (arg.kind === 'arg.group') return `{${stringifyLatexNodes((arg as any).content ?? [], options, depth + 1)}}`;
  if (arg.kind === 'arg.optional') return `[${stringifyLatexNodes((arg as any).content ?? [], options, depth + 1)}]`;
  return options.strict ? throwUnhandled(arg) : '';
}

function stringifyOne(node: LatexNode, options: Required<StringifyLatexOptions>, depth: number): string {
  const kind = (node as any).kind as string;
  if (depth > options.maxDepth) {
    return options.strict ? throwUnhandled(node) : '';
  }

  // Text-mode nodes
  if (kind === 'text.string') return (node as any).content ?? '';
  if (kind === 'space') return ' ';
  if (kind === 'parbreak') return '\n\n';
  if (kind === 'newline') return '\n';
  if (kind === 'linebreak') return '\\\\';
  if (kind === 'alignmentTab') return '&';
  if (kind === 'comment') return '';

  // Arguments / groups
  if (kind === 'arg.group' || kind === 'arg.optional') {
    return formatArg(node, options, depth);
  }

  // Standard commands: \name{...}[...]
  if (kind === 'command') {
    const name = (node as any).name ?? '';
    const args = Array.isArray((node as any).args) ? (node as any).args : [];
    return `\\${name}${args.map((a: any) => (isNodeLike(a) ? formatArg(a, options, depth) : '')).join('')}`;
  }

  // Math-mode special commands parsed as command.X (e.g. command.text)
  // NOTE: latex-utensils parses \label/\ref/\eqref/etc as kind "command.label" with a "label" field,
  // and we intentionally drop them to avoid leaking label keys into evidence text.
  if (kind === 'command.label') return '';

  const cmdFromKind = cmdNameFromKind(kind);
  if (cmdFromKind) {
    const single = (node as any).arg;
    const many = (node as any).args;
    if (isNodeLike(single)) return `\\${cmdFromKind}${formatArg(single, options, depth)}`;
    if (Array.isArray(many)) {
      return `\\${cmdFromKind}${many.map((a: any) => (isNodeLike(a) ? formatArg(a, options, depth) : '')).join('')}`;
    }
    return `\\${cmdFromKind}`;
  }

  // Math containers / atoms
  if (kind === 'inlineMath') return `$${stringifyLatexNodes((node as any).content ?? [], options, depth + 1)}$`;
  if (kind === 'displayMath') return `\\[${stringifyLatexNodes((node as any).content ?? [], options, depth + 1)}\\]`;
  if (kind === 'math.character') return (node as any).content ?? '';

  if (kind === 'subscript') {
    const arg = (node as any).arg;
    if (isNodeLike(arg)) {
      if (arg.kind === 'arg.group' || arg.kind === 'arg.optional') return `_${formatArg(arg, options, depth)}`;
      // For single math.character subscripts (e.g., in math mode file paths), 
      // output _X instead of _{X} to preserve file path format
      if (arg.kind === 'math.character') {
        return `_${(arg as any).content || ''}`;
      }
      return `_{${stringifyOne(arg, options, depth + 1)}}`;
    }
    // No arg means bare underscore (e.g., in file paths like "file_name.eps")
    return '_';
  }
  if (kind === 'superscript') {
    const arg = (node as any).arg;
    if (isNodeLike(arg)) {
      if (arg.kind === 'arg.group' || arg.kind === 'arg.optional') return `^${formatArg(arg, options, depth)}`;
      return `^{${stringifyOne(arg, options, depth + 1)}}`;
    }
    // No arg means bare caret (rare but possible)
    return '^';
  }

  // Environments
  if (latexParser.isEnvironment(node)) {
    const name = (node as any).name ?? '';
    const args = Array.isArray((node as any).args) ? (node as any).args : [];
    const body = stringifyLatexNodes((node as any).content ?? [], options, depth + 1);
    return `\\begin{${name}}${args.map((a: any) => (isNodeLike(a) ? formatArg(a, options, depth) : '')).join('')}\n${body}\n\\end{${name}}`;
  }

  // Fallback: try common container-like fields.
  const content = (node as any).content;
  if (Array.isArray(content)) return stringifyLatexNodes(content, options, depth + 1);

  const arg = (node as any).arg;
  if (isNodeLike(arg)) return stringifyOne(arg, options, depth + 1);

  const args = (node as any).args;
  if (Array.isArray(args)) return args.map((a: any) => (isNodeLike(a) ? stringifyOne(a, options, depth + 1) : '')).join('');

  return options.strict ? throwUnhandled(node) : '';
}

export function stringifyLatexNodes(
  nodes: LatexNode[],
  options?: StringifyLatexOptions,
  depth = 0
): string {
  const resolved = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  return nodes.map((n) => stringifyOne(n, resolved, depth)).join('');
}

export function stringifyLatexNode(node: LatexNode, options?: StringifyLatexOptions): string {
  const resolved = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  return stringifyOne(node, resolved, 0);
}
