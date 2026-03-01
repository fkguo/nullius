/**
 * LaTeX Table Extractor
 * Extracts table environments from LaTeX AST using latex-utensils
 */

import { latexParser } from 'latex-utensils';
import type { LatexAst, LatexNode, Locator } from './parser.js';
import { extractText } from './sectionExtractor.js';
import { nodeToLocator } from './locator.js';
import { stringifyLatexNodes } from './astStringify.js';
import { stripLatexPreserveHEP } from '../../../utils/latex.js';

const { find } = latexParser;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Table {
  /** Label (e.g., "tab:results") */
  label?: string;
  /** Caption text */
  caption?: string;
  /** Column specification (e.g., "|l|c|r|") */
  column_spec?: string;
  /** Table data as 2D array */
  data: string[][];
  /** Header row if identifiable */
  headers?: string[];
  /** Section where table appears */
  section?: string;
  /** Hierarchical section path where table appears */
  section_path?: string[];
  /** Number of rows */
  row_count: number;
  /** Number of columns */
  column_count: number;
  /** Source location */
  location?: Locator;
  /** Image path if table is embedded as image */
  image_path?: string;
  /** Table content type */
  content_type?: 'tabular' | 'matrix' | 'image';
}

export interface ExtractTablesOptions {
  /** Include longtable environments (default: true) */
  include_longtable?: boolean;
  /** Parse table data into cells (default: true) */
  parse_data?: boolean;
  /** Max rows to parse (default: 100) */
  max_rows?: number;
  /** Source file path for location info */
  file?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TABLE_ENVS = new Set(['table', 'table*']);
const TABULAR_ENVS = new Set([
  'tabular', 'tabular*', 'tabularx', 'tabulary',
  'array', 'longtable', 'supertabular', 'supertabular*',
  'xtabular', 'xtabular*', 'mpsupertabular',
]);
const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get command argument as text
 */
function normalizeCommandName(name: string): string {
  return name.replace(/\*+$/, '').toLowerCase();
}

function getRequiredArgNodes(node: LatexNode, index = 0): LatexNode[] {
  if (!latexParser.isCommand(node)) return [];
  const groups = node.args.filter((a) => latexParser.isGroup(a)) as Array<{ content: LatexNode[] }>;
  return groups[index]?.content ?? [];
}

function getRequiredArgText(node: LatexNode, index = 0): string {
  if (!latexParser.isCommand(node)) return '';
  return extractText(getRequiredArgNodes(node, index));
}

function getRequiredArgLatex(node: LatexNode, index = 0): string {
  if (!latexParser.isCommand(node)) return '';
  const content = getRequiredArgNodes(node, index);
  return content.length ? stringifyLatexNodes(content) : '';
}

/**
 * Extract label from nodes using find()
 */
function extractLabel(nodes: LatexNode[]): string | undefined {
  const result = find(nodes, latexParser.isLabelCommand);
  return result?.node.label;
}

/**
 * Extract caption from nodes
 */
function extractCaption(nodes: LatexNode[]): string | undefined {
  for (const node of nodes) {
    if (latexParser.isCommand(node) && normalizeCommandName(node.name) === 'caption') {
      const raw = getRequiredArgLatex(node);
      const text = stripLatexPreserveHEP(raw).trim();
      return text || undefined;
    }
    if (latexParser.isGroup(node)) {
      const caption = extractCaption(node.content);
      if (caption) return caption;
    }
  }
  return undefined;
}

/**
 * Get column specification from tabular environment
 */
function getColumnSpec(node: LatexNode): string | undefined {
  if (!latexParser.isEnvironment(node)) return undefined;
  for (const arg of node.args || []) {
    if (latexParser.isGroup(arg)) {
      return extractText(arg.content);
    }
  }
  return undefined;
}

/**
 * Parse tabular content into rows and cells
 * Handles both text-based separators and LaTeX command forms
 */
function parseTabularContent(
  nodes: LatexNode[],
  maxRows: number
): { data: string[][]; headers?: string[] } {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let headers: string[] | undefined;

  function flushCell() {
    currentRow.push(currentCell.trim());
    currentCell = '';
  }

  function flushRow() {
    flushCell();
    if (currentRow.some(c => c)) {
      rows.push(currentRow);
    }
    currentRow = [];
  }

  // Check if a command represents a row ending
  function isRowEndCommand(name: string): boolean {
    const lower = name.toLowerCase();
    // Common row-ending commands and variations
    return lower === '\\' ||           // literal backslash-backslash
           lower === 'newline' ||
           lower === 'tabularnewline' ||
           lower === 'cr' ||
           lower === '\\\\';           // double backslash stored as command name
  }

  // Check if a command is a horizontal rule (potential header separator)
  function isHorizontalRule(name: string): boolean {
    const lower = name.toLowerCase();
    return lower === 'hline' ||
           lower === 'toprule' ||
           lower === 'midrule' ||
           lower === 'bottomrule' ||
           lower === 'cline' ||
           lower === 'cmidrule' ||
           lower === 'tableline' ||  // AAS style
           lower === 'colrule';      // Some styles
  }

  function processNode(node: LatexNode) {
    // Handle alignmentTab (column separator in AST)
    if ((node as { kind?: string }).kind === 'alignmentTab') {
      flushCell();
      return;
    }
    
    // Handle linebreak (row separator in AST)  
    if (latexParser.isLinebreak(node) || (node as { kind?: string }).kind === 'linebreak') {
      flushRow();
      return;
    }
    
    // Handle space nodes - skip
    if ((node as { kind?: string }).kind === 'space') {
      return;
    }
    
    if (latexParser.isTextString(node)) {
      const text = node.content;
      let i = 0;

      while (i < text.length) {
        if (text[i] === '&') {
          flushCell();
          i += 1;
        } else if (text[i] === '\\' && text[i + 1] === '\\') {
          // Text-form row separator
          flushRow();
          i += 2;
          // Skip optional whitespace and newline after \\
          while (i < text.length && /[\s\n\r]/.test(text[i]!)) i++;
        } else if (text[i] === '\n' || text[i] === '\r') {
          // Whitespace - just skip, not a cell/row boundary
          i += 1;
        } else {
          currentCell += text[i];
          i += 1;
        }
      }
    } else if (latexParser.isCommand(node)) {
      const cmdName = node.name;
      
      // Row-ending commands
      if (isRowEndCommand(cmdName)) {
        flushRow();
        return;
      }
      
      // Horizontal rules - mark potential header boundary
      if (isHorizontalRule(cmdName)) {
        // Mark potential header boundary after first row
        if (rows.length === 1 && !headers) {
          headers = rows[0];
        }
        return;
      }
      
      // Handle multicolumn - extract the cell content (3rd argument)
      if (cmdName === 'multicolumn') {
        const content = getRequiredArgText(node, 2);
        currentCell += content;
        return;
      }
      
      // Handle multirow - extract the cell content (3rd argument)
      if (cmdName === 'multirow') {
        const content = getRequiredArgText(node, 2);
        currentCell += content;
        return;
      }
      
      // Handle text formatting commands - extract content
      if (['textbf', 'textit', 'textrm', 'textsc', 'emph', 'mathrm', 'mathbf'].includes(cmdName)) {
        currentCell += getRequiredArgText(node, 0);
        return;
      }
      
      // For other commands, extract text representation
      const cmdText = extractText([node]).trim();
      if (cmdText) {
        currentCell += cmdText;
      }
    } else if (latexParser.isGroup(node)) {
      currentCell += extractText(node.content);
    } else if (latexParser.isMathEnv(node) || latexParser.isInlineMath(node) || 
               (node as { kind?: string }).kind === 'inlineMath' ||
               (node as { kind?: string }).kind === 'displayMath') {
      // Inline/display math - use stringifyLatexNodes to preserve math content
      currentCell += stringifyLatexNodes([node]);
    } else if (latexParser.isLinebreak(node)) {
      // latex-utensils LineBreak node - row separator
      flushRow();
    }
  }

  for (const node of nodes) {
    if (rows.length >= maxRows) break;
    processNode(node);
  }

  // Push final row if not empty
  if (currentCell) {
    currentRow.push(currentCell.trim());
  }
  if (currentRow.some(c => c)) {
    rows.push(currentRow);
  }

  return { data: rows, headers };
}

/**
 * Find \includegraphics within table (for image-based tables)
 */
function findTableImage(nodes: LatexNode[]): string | undefined {
  for (const node of nodes) {
    if (latexParser.isCommand(node)) {
      const cmdName = node.name.toLowerCase();
      if (cmdName === 'includegraphics') {
        // Get the image path from the last required argument
        for (let i = node.args.length - 1; i >= 0; i--) {
          const arg = node.args[i];
          if (latexParser.isGroup(arg) && arg.kind === 'arg.group') {
            const text = stringifyLatexNodes(arg.content).trim();
            if (text && !text.includes('=')) {
              return text;
            }
          }
        }
      }
    }
    // Recurse
    if (latexParser.isGroup(node)) {
      const found = findTableImage(node.content);
      if (found) return found;
    }
    if (latexParser.isEnvironment(node)) {
      const found = findTableImage(node.content);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Find \matrix command within displayMath (plain TeX tables)
 */
function findMatrix(nodes: LatexNode[]): LatexNode | undefined {
  for (const node of nodes) {
    if (latexParser.isDisplayMath(node) || latexParser.isInlineMath(node)) {
      // Look for \matrix command inside
      for (const inner of node.content) {
        if (latexParser.isCommand(inner) && inner.name.toLowerCase() === 'matrix') {
          return inner;
        }
      }
    }
    // Recurse
    if (latexParser.isGroup(node)) {
      const found = findMatrix(node.content);
      if (found) return found;
    }
    if (latexParser.isEnvironment(node)) {
      const found = findMatrix(node.content);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Parse plain TeX \matrix content (uses \cr for rows, & for columns)
 */
function parseMatrixContent(node: LatexNode): { data: string[][]; row_count: number; column_count: number } {
  const data: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';

  function processNode(n: LatexNode) {
    if (latexParser.isCommand(n)) {
      const name = n.name.toLowerCase();
      if (name === 'cr') {
        // Row break
        currentRow.push(currentCell.trim());
        if (currentRow.some(c => c.length > 0)) {
          data.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
        return;
      }
      if (name === 'noalign' || name === 'hrule' || name === 'vskip') {
        // Skip formatting commands
        return;
      }
      if (name === 'hbox') {
        // Extract text from \hbox{...}
        for (const arg of n.args) {
          if (latexParser.isGroup(arg)) {
            currentCell += stringifyLatexNodes(arg.content);
          }
        }
        return;
      }
      // Other commands - stringify
      currentCell += stringifyLatexNodes([n]);
    } else if (latexParser.isAlignmentTab(n)) {
      // Column separator
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (latexParser.isGroup(n)) {
      for (const c of n.content) processNode(c);
    } else {
      currentCell += stringifyLatexNodes([n]);
    }
  }

  // Process the matrix argument content
  if (latexParser.isCommand(node) && node.args) {
    for (const arg of node.args) {
      if (latexParser.isGroup(arg)) {
        for (const c of arg.content) processNode(c);
      }
    }
  }

  // Don't forget the last cell/row
  if (currentCell.trim()) {
    currentRow.push(currentCell.trim());
  }
  if (currentRow.some(c => c.length > 0)) {
    data.push(currentRow);
  }

  const row_count = data.length;
  const column_count = data.length > 0 ? Math.max(...data.map(r => r.length)) : 0;

  return { data, row_count, column_count };
}

/**
 * Find tabular environment within table
 */
function findTabular(
  nodes: LatexNode[],
  includeLongtable: boolean
): LatexNode | undefined {
  for (const node of nodes) {
    if (latexParser.isEnvironment(node)) {
      if (TABULAR_ENVS.has(node.name)) {
        if (node.name === 'longtable' && !includeLongtable) {
          continue;
        }
        return node;
      }
      // Search in content
      const inner = findTabular(node.content, includeLongtable);
      if (inner) return inner;
      // Also search in args (latex-utensils may put {tabular} in env args)
      if (node.args) {
        for (const arg of node.args) {
          if (latexParser.isGroup(arg) && arg.content) {
            const innerArg = findTabular(arg.content, includeLongtable);
            if (innerArg) return innerArg;
          }
        }
      }
    }
    // Also search command args (latex-utensils may attach {tabular} to preceding command)
    if (latexParser.isCommand(node) && node.args) {
      for (const arg of node.args) {
        if (latexParser.isGroup(arg) && arg.content) {
          const inner = findTabular(arg.content, includeLongtable);
          if (inner) return inner;
        }
      }
    }
    if (latexParser.isGroup(node)) {
      const inner = findTabular(node.content, includeLongtable);
      if (inner) return inner;
    }
    // Also search in math environments (displayMath, inlineMath may contain array)
    if (latexParser.isMathEnv(node) || latexParser.isDisplayMath(node) || latexParser.isInlineMath(node)) {
      const inner = findTabular(node.content, includeLongtable);
      if (inner) return inner;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract tables from LaTeX AST
 */
export function extractTables(
  ast: LatexAst,
  options: ExtractTablesOptions = {}
): Table[] {
  if (ast.kind !== 'ast.root') return [];

  const {
    include_longtable = true,
    parse_data = true,
    max_rows = 100,
    file = 'unknown',
  } = options;

  const tables: Table[] = [];
  const sectionStack: Array<{ level: number; title: string }> = [];

  function traverse(nodes: LatexNode[]) {
    for (const node of nodes) {
      // Update current section
      if (latexParser.isCommand(node)) {
        const base = normalizeCommandName(node.name);
        const level = SECTION_LEVELS[base];
        if (level !== undefined) {
          const title = getRequiredArgText(node);
          while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1]!.level >= level) {
            sectionStack.pop();
          }
          sectionStack.push({ level, title });
        }
      }

      // Detect table environments
      if (latexParser.isEnvironment(node)) {
        if (TABLE_ENVS.has(node.name)) {
          // Find tabular inside table (search both content and args)
          let tabular = findTabular(node.content, include_longtable);
          // Also search in env args (latex-utensils may put {tabular} in table args)
          if (!tabular && node.args) {
            for (const arg of node.args) {
              if (latexParser.isGroup(arg) && arg.content) {
                tabular = findTabular(arg.content, include_longtable);
                if (tabular) break;
              }
            }
          }

          const table: Table = {
            label: extractLabel(node.content),
            caption: extractCaption(node.content),
            section: sectionStack.length > 0 ? sectionStack[sectionStack.length - 1]!.title : undefined,
            section_path: sectionStack.map(s => s.title).filter(Boolean),
            data: [],
            row_count: 0,
            column_count: 0,
            location: nodeToLocator(node, file),
          };

          if (tabular && latexParser.isEnvironment(tabular)) {
            // Standard tabular environment
            table.content_type = 'tabular';
            table.column_spec = getColumnSpec(tabular);

            if (parse_data) {
              const parsed = parseTabularContent(tabular.content, max_rows);
              table.data = parsed.data;
              table.headers = parsed.headers;
              table.row_count = parsed.data.length;
              table.column_count = Math.max(...parsed.data.map(r => r.length), 0);
            }
          } else {
            // Try to find \matrix (plain TeX) or \includegraphics (image table)
            const matrix = findMatrix(node.content);
            if (matrix) {
              table.content_type = 'matrix';
              if (parse_data) {
                const parsed = parseMatrixContent(matrix);
                table.data = parsed.data;
                table.row_count = parsed.row_count;
                table.column_count = parsed.column_count;
              }
            } else {
              // Check for image-based table
              const imagePath = findTableImage(node.content);
              if (imagePath) {
                table.content_type = 'image';
                table.image_path = imagePath;
                table.row_count = 1; // Mark as having content
                table.column_count = 1; // Mark as having content
              }
            }
          }

          tables.push(table);
        } else if (node.name === 'longtable' && include_longtable) {
          // Standalone longtable
          const table: Table = {
            label: extractLabel(node.content),
            caption: extractCaption(node.content),
            column_spec: getColumnSpec(node),
            section: sectionStack.length > 0 ? sectionStack[sectionStack.length - 1]!.title : undefined,
            section_path: sectionStack.map(s => s.title).filter(Boolean),
            data: [],
            row_count: 0,
            column_count: 0,
            location: nodeToLocator(node, file),
          };

          if (parse_data) {
            const parsed = parseTabularContent(node.content, max_rows);
            table.data = parsed.data;
            table.headers = parsed.headers;
            table.row_count = parsed.data.length;
            table.column_count = Math.max(...parsed.data.map(r => r.length), 0);
          }

          tables.push(table);
        } else {
          // Recurse into other environments
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
  return tables;
}
