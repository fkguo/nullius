/**
 * LaTeX Theorem Extractor
 * Extracts theorem-like environments from LaTeX AST using latex-utensils
 */

import { latexParser } from 'latex-utensils';
import type { LatexAst, LatexNode, Locator } from './parser.js';
import { extractText } from './sectionExtractor.js';
import { nodeToLocator } from './locator.js';
import { stringifyLatexNodes } from './astStringify.js';

// Use latexParser's find helper
const { find } = latexParser;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TheoremType =
  | 'theorem'
  | 'lemma'
  | 'proposition'
  | 'corollary'
  | 'definition'
  | 'remark'
  | 'example'
  | 'proof'
  | 'conjecture'
  | 'claim'
  | 'custom';

export interface Theorem {
  /** Theorem type */
  type: TheoremType;
  /** Original environment name */
  env_name: string;
  /** Label (e.g., "thm:main") */
  label?: string;
  /** Title (e.g., "Main Result" from \begin{theorem}[Main Result]) */
  title?: string;
  /** Content in LaTeX format */
  content_latex: string;
  /** Content in plain text */
  content_text: string;
  /** Section where theorem appears */
  section?: string;
  /** Source location */
  location?: Locator;
  /** Associated proof */
  proof?: {
    content_latex: string;
    content_text: string;
    location?: Locator;
  };
}

export interface ExtractTheoremsOptions {
  /** Theorem types to include */
  include_types?: TheoremType[];
  /** Include proofs (default: true) */
  include_proofs?: boolean;
  /** Custom environment mappings */
  custom_environments?: Record<string, TheoremType>;
  /** Max content length (default: 0 = no limit) */
  max_content_length?: number;
  /** Source file path for location info */
  file?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const THEOREM_ENV_MAP: Record<string, TheoremType> = {
  theorem: 'theorem',
  thm: 'theorem',
  lemma: 'lemma',
  lem: 'lemma',
  proposition: 'proposition',
  prop: 'proposition',
  corollary: 'corollary',
  cor: 'corollary',
  definition: 'definition',
  defn: 'definition',
  def: 'definition',
  remark: 'remark',
  rem: 'remark',
  example: 'example',
  ex: 'example',
  proof: 'proof',
  pf: 'proof',
  conjecture: 'conjecture',
  conj: 'conjecture',
  claim: 'claim',
};

const SECTION_COMMANDS = new Set([
  'part', 'chapter', 'section', 'subsection', 'subsubsection',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract label from nodes using find()
 */
function extractLabel(nodes: LatexNode[]): string | undefined {
  const result = find(nodes, latexParser.isLabelCommand);
  return result?.node.label;
}

/**
 * Get command argument as text
 */
function getCommandArg(node: LatexNode): string {
  if (!latexParser.isCommand(node)) return '';
  const arg = node.args[0];
  if (!arg || !latexParser.isGroup(arg)) return '';
  return extractText(arg.content);
}

/**
 * Stringify with optional length limit
 */
function stringifyWithLimit(nodes: LatexNode[], maxLength: number): string {
  const result = stringifyLatexNodes(nodes);
  if (maxLength > 0 && result.length > maxLength) {
    return result.slice(0, maxLength) + '...';
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract theorems from LaTeX AST
 */
export function extractTheorems(
  ast: LatexAst,
  options: ExtractTheoremsOptions = {}
): Theorem[] {
  if (ast.kind !== 'ast.root') return [];

  const {
    include_types,
    include_proofs = true,
    custom_environments = {},
    max_content_length = 0,
    file = 'unknown',
  } = options;

  // Merge environment mappings
  const envMap = { ...THEOREM_ENV_MAP, ...custom_environments };

  const theorems: Theorem[] = [];
  let currentSection: string | undefined;
  let pendingTheorem: Theorem | null = null;

  function traverse(nodes: LatexNode[]) {
    for (const node of nodes) {
      // Update current section
      if (latexParser.isCommand(node) && SECTION_COMMANDS.has(node.name)) {
        currentSection = getCommandArg(node);
      }

      // Detect theorem environments
      if (latexParser.isEnvironment(node)) {
        const envName = node.name.toLowerCase();
        const theoremType = envMap[envName];

        if (theoremType) {
          // Filter by type
          if (include_types && !include_types.includes(theoremType)) {
            traverse(node.content);
            continue;
          }

          // Handle proof environment
          if (theoremType === 'proof') {
            if (include_proofs && pendingTheorem) {
              pendingTheorem.proof = {
                content_latex: stringifyWithLimit(node.content, max_content_length),
                content_text: extractText(node.content),
                location: nodeToLocator(node, file),
              };
            }
            continue;
          }

          // Extract theorem
          const theorem: Theorem = {
            type: theoremType,
            env_name: node.name,
            content_latex: stringifyWithLimit(node.content, max_content_length),
            content_text: extractText(node.content),
            section: currentSection,
            location: nodeToLocator(node, file),
          };

          // Extract label
          theorem.label = extractLabel(node.content);

          // Extract title from optional argument
          if (node.args && node.args.length > 0) {
            const firstArg = node.args[0];
            if (latexParser.isOptionalArg(firstArg)) {
              theorem.title = extractText(firstArg.content);
            }
          }

          theorems.push(theorem);
          pendingTheorem = theorem;
        } else {
          // Recurse into non-theorem environments
          traverse(node.content);
        }
      }
    }
  }

  // Find document environment
  let docContent = ast.content;
  for (const node of ast.content) {
    if (latexParser.isEnvironment(node) && node.name === 'document') {
      docContent = node.content;
      break;
    }
  }

  traverse(docContent);
  return theorems;
}
