/**
 * LaTeX Figure Extractor
 * Extracts figure environments from LaTeX AST using latex-utensils
 */

import { latexParser } from 'latex-utensils';
import type { LatexAst, LatexNode, Locator } from './parser.js';
import { extractText } from './sectionExtractor.js';
import { nodeToLocator } from './locator.js';
import { stringifyLatexNodes } from './astStringify.js';
import { stripLatexPreserveHEP } from '../../writing/rag/hepTokenizer.js';

// Use latexParser's find
const { find } = latexParser;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SubFigure {
  /** Label (e.g., "fig:sub1") */
  label?: string;
  /** Caption text */
  caption?: string;
  /** Image path */
  image_path?: string;
  /** Width specification */
  width?: string;
  /** Source location */
  location?: Locator;
}

export interface Figure {
  /** Label (e.g., "fig:main") */
  label?: string;
  /** Caption text */
  caption?: string;
  /** Image paths from \includegraphics */
  image_paths: string[];
  /** Placement specifier (e.g., "htbp") */
  placement?: string;
  /** Section where figure appears */
  section?: string;
  /** Hierarchical section path where figure appears */
  section_path?: string[];
  /** Whether this is a subfigure container */
  is_subfigure: boolean;
  /** Subfigures if any */
  subfigures?: SubFigure[];
  /** Width specification */
  width?: string;
  /** Source location */
  location?: Locator;
  /** Inline drawing type (tikz, picture, feynman, pstricks, etc.) */
  drawing_type?: string;
  /** Inline drawing LaTeX source code for LLM understanding */
  drawing_source?: string;
}

export interface ExtractFiguresOptions {
  /** Include subfigures (default: true) */
  include_subfigures?: boolean;
  /** Include wrapfigures (default: true) */
  include_wrapfigures?: boolean;
  /** Source file path for location info */
  file?: string;
  /** Custom graphics macros from preamble (e.g., { inclfig: 2, hefig: 1 } where value is the arg index containing path) */
  custom_graphics_macros?: Map<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const FIGURE_ENVS = new Set(['figure', 'figure*', 'wrapfigure']);

// Inline drawing environments that can be extracted for LLM understanding
const DRAWING_ENVS: Record<string, string> = {
  'tikzpicture': 'tikz',
  'tikz': 'tikz',
  'picture': 'picture',
  'pspicture': 'pstricks',
  'pgfpicture': 'pgf',
  'circuitikz': 'circuitikz',
  'feynman': 'feynman',
  'fmfgraph': 'feynman',
  'fmfgraph*': 'feynman',
  'chronology': 'chronology',  // Timeline charts
  'chronology*': 'chronology',
  'tabular': 'tabular',        // Tables used as figures
  'tabular*': 'tabular',
  'array': 'array',            // Math arrays used as figures
};
const SUBFIGURE_ENVS = new Set(['subfigure', 'subfloat']);
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
 * Get optional argument as text
 */
function getOptionalArg(node: LatexNode): string | undefined {
  if (!latexParser.isCommand(node)) return undefined;
  for (const arg of node.args) {
    if (latexParser.isOptionalArg(arg)) {
      return extractText(arg.content);
    }
  }
  return undefined;
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
    if (latexParser.isEnvironment(node)) {
      const caption = extractCaption(node.content);
      if (caption) return caption;
    }
  }
  return undefined;
}

/**
 * Extract graphics paths and widths from various graphics commands.
 * Supports: \includegraphics, \epsfbox, \epsfig, \psfig, etc.
 * Also supports custom user-defined macros that wrap these commands.
 * 
 * @param nodes - AST nodes to search
 * @param customMacros - Map of custom macro names to arg index containing path (0-based)
 */
function extractIncludegraphics(
  nodes: LatexNode[],
  customMacros?: Map<string, number>
): Array<{ path: string; width?: string }> {
  const results: Array<{ path: string; width?: string }> = [];

  for (const node of nodes) {
    if (latexParser.isCommand(node)) {
      const cmdName = node.name.toLowerCase();
      const cmdNameOrig = node.name; // Preserve original case for custom macros

      // Modern \includegraphics and \includegraphics*
      // Use getRequiredArgLatex to preserve underscores in file paths
      if (cmdName === 'includegraphics' || cmdName === 'includegraphics*') {
        const path = getRequiredArgLatex(node);
        const optArg = getOptionalArg(node);
        let width: string | undefined;
        if (optArg) {
          const widthMatch = optArg.match(/width\s*=\s*([^,\]]+)/);
          if (widthMatch) {
            width = widthMatch[1].trim();
          }
        }
        if (path) {
          results.push({ path, width });
        }
      }
      // Legacy \epsfbox{file.eps} and \epsffile{file.eps}
      // Use getRequiredArgLatex to preserve underscores in file paths
      else if (cmdName === 'epsfbox' || cmdName === 'epsffile') {
        const path = getRequiredArgLatex(node);
        if (path) {
          results.push({ path });
        }
      }
      // Legacy \epsfig{file=name.eps,width=...} or \epsfig{figure=name.eps,width=...}
      // Use getRequiredArgLatex to preserve underscores in file paths
      else if (cmdName === 'epsfig') {
        const arg = getRequiredArgLatex(node);
        if (arg) {
          // Support both file= and figure= keys
          const fileMatch = arg.match(/(?:file|figure)\s*=\s*([^,}\s]+)/i);
          const widthMatch = arg.match(/width\s*=\s*([^,}\s]+)/i);
          if (fileMatch) {
            results.push({ path: fileMatch[1], width: widthMatch?.[1] });
          }
        }
      }
      // Legacy \psfig{figure=name.eps,width=...} and \psfig{file=...}
      // Use getRequiredArgLatex to preserve underscores in file paths
      else if (cmdName === 'psfig' || cmdName === 'psfigure') {
        const arg = getRequiredArgLatex(node);
        if (arg) {
          const figureMatch = arg.match(/(?:figure|file)\s*=\s*([^,}\s]+)/i);
          const widthMatch = arg.match(/width\s*=\s*([^,}\s]+)/i);
          if (figureMatch) {
            results.push({ path: figureMatch[1], width: widthMatch?.[1] });
          }
        }
      }
      // Custom user-defined graphics macros (e.g., \inclfig, \hefig, \infig)
      else if (customMacros?.has(cmdNameOrig) || customMacros?.has(cmdName)) {
        const argIndex = customMacros.get(cmdNameOrig) ?? customMacros.get(cmdName) ?? 0;
        const path = getRequiredArgLatex(node, argIndex);
        if (path) {
          // Try to extract width from other args
          const widthArg = getRequiredArgLatex(node, argIndex === 0 ? 1 : 0);
          results.push({ path, width: widthArg || undefined });
        }
      }
      // Legacy \special{psfile=filename.ps ...} command
      else if (cmdName === 'special') {
        const arg = getRequiredArgLatex(node);
        if (arg) {
          // Match psfile=name.ext, where ext is a known image extension
          // The regex handles cases where newlines are stripped and params run together
          const psfileMatch = arg.match(/psfile\s*=\s*([^\s,}=]+\.(?:epsi|eps|ps|pdf|png|jpg|jpeg))/i);
          if (psfileMatch) {
            results.push({ path: psfileMatch[1] });
          }
        }
      }
      // For other commands (e.g., \centerline, \makebox, \parbox, etc.),
      // recurse into their arguments to find nested graphics commands
      else {
        for (const arg of node.args) {
          if (latexParser.isGroup(arg)) {
            results.push(...extractIncludegraphics(arg.content, customMacros));
          }
        }
      }
    }

    // Recurse into groups and environments (including math environments)
    if (latexParser.isGroup(node)) {
      results.push(...extractIncludegraphics(node.content, customMacros));
    }
    if (latexParser.isEnvironment(node) || latexParser.isMathEnv(node)) {
      results.push(...extractIncludegraphics(node.content, customMacros));
    }
  }

  return results;
}

/**
 * Extract nodes from environment args (latex-utensils may put leading groups into args)
 */
function extractNodesFromArgs(args: LatexNode[] | undefined): LatexNode[] {
  if (!args) return [];
  const result: LatexNode[] = [];
  for (const arg of args) {
    // Skip optional args like [ht!]
    if (latexParser.isOptionalArg(arg)) continue;
    // Include group args (which may contain graphics commands)
    if (latexParser.isGroup(arg) && arg.content) {
      result.push(...arg.content);
    }
  }
  return result;
}

/**
 * Extract inline drawing environments (TikZ, picture, etc.) from figure content
 * Returns the drawing type and stringified source code
 */
function extractInlineDrawing(nodes: LatexNode[]): { type: string; source: string } | undefined {
  for (const node of nodes) {
    if (latexParser.isEnvironment(node)) {
      const envName = node.name.toLowerCase();
      const drawingType = DRAWING_ENVS[envName];
      
      if (drawingType) {
        // Stringify the entire environment including \begin and \end
        const source = stringifyLatexNodes([node]);
        return { type: drawingType, source };
      }
      
      // Recurse into nested environments
      const nested = extractInlineDrawing(node.content);
      if (nested) return nested;
    }
    
    if (latexParser.isGroup(node)) {
      const nested = extractInlineDrawing(node.content);
      if (nested) return nested;
    }
    
    // Check for \include{file} or \input{file} commands (unexpanded file references)
    if (latexParser.isCommand(node)) {
      const cmdName = node.name.toLowerCase();
      if (cmdName === 'include' || cmdName === 'input') {
        const fileName = getRequiredArgLatex(node);
        if (fileName) {
          // Return as a special "include" type that can be resolved later
          return { type: 'include', source: `\\${node.name}{${fileName}}` };
        }
      }
      
      // Recurse into command arguments
      for (const arg of node.args) {
        if (latexParser.isGroup(arg)) {
          const nested = extractInlineDrawing(arg.content);
          if (nested) return nested;
        }
      }
    }
  }
  
  return undefined;
}

/**
 * Extract non-standard graphics macros (e.g., \gepsfcentered, \epsfxsize)
 */
function extractNonStandardGraphics(nodes: LatexNode[]): Array<{ path: string; macro: string }> {
  const results: Array<{ path: string; macro: string }> = [];
  
  for (const node of nodes) {
    if (latexParser.isCommand(node)) {
      const cmdName = node.name.toLowerCase();
      
      // \gepsfcentered[...]{file.ps} - custom EPS macro
      if (cmdName === 'gepsfcentered' || cmdName === 'gepsf' || cmdName === 'epsfcentered') {
        const path = getRequiredArgLatex(node);
        if (path) {
          results.push({ path, macro: node.name });
        }
      }
      
      // \plotone{file} and \plottwo{file1}{file2} - AASTeX macros
      else if (cmdName === 'plotone') {
        const path = getRequiredArgLatex(node);
        if (path) {
          results.push({ path, macro: 'plotone' });
        }
      }
      else if (cmdName === 'plottwo') {
        const path1 = getRequiredArgLatex(node, 0);
        const path2 = getRequiredArgLatex(node, 1);
        if (path1) results.push({ path: path1, macro: 'plottwo' });
        if (path2) results.push({ path: path2, macro: 'plottwo' });
      }
      
      // Recurse into command arguments
      for (const arg of node.args) {
        if (latexParser.isGroup(arg)) {
          results.push(...extractNonStandardGraphics(arg.content));
        }
      }
    }
    
    // Recurse into groups and environments
    if (latexParser.isGroup(node)) {
      results.push(...extractNonStandardGraphics(node.content));
    }
    if (latexParser.isEnvironment(node)) {
      results.push(...extractNonStandardGraphics(node.content));
    }
  }
  
  return results;
}

/**
 * Extract subfigures from figure content
 */
function extractSubfigures(nodes: LatexNode[]): SubFigure[] {
  const subfigures: SubFigure[] = [];

  for (const node of nodes) {
    if (latexParser.isEnvironment(node) && SUBFIGURE_ENVS.has(node.name)) {
      const graphics = extractIncludegraphics(node.content);
      const subfig: SubFigure = {
        label: extractLabel(node.content),
        caption: extractCaption(node.content),
        image_path: graphics[0]?.path,
        width: graphics[0]?.width,
      };
      subfigures.push(subfig);
    }
    // Handle \subfloat command
    if (latexParser.isCommand(node) && node.name === 'subfloat') {
      const content: LatexNode[] = [];
      for (const arg of node.args) {
        if (latexParser.isGroup(arg)) {
          content.push(...arg.content);
        }
      }
      const graphics = extractIncludegraphics(content);
      const caption = getOptionalArg(node);
      const subfig: SubFigure = {
        label: extractLabel(content),
        caption,
        image_path: graphics[0]?.path,
        width: graphics[0]?.width,
      };
      subfigures.push(subfig);
    }
    if (latexParser.isGroup(node)) {
      subfigures.push(...extractSubfigures(node.content));
    }
  }

  return subfigures;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract figures from LaTeX AST
 */
export function extractFigures(
  ast: LatexAst,
  options: ExtractFiguresOptions = {}
): Figure[] {
  if (ast.kind !== 'ast.root') return [];

  const {
    include_subfigures = true,
    include_wrapfigures = true,
    file = 'unknown',
    custom_graphics_macros,
  } = options;

  const figures: Figure[] = [];
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

      // Detect figure environments
      if (latexParser.isEnvironment(node)) {
        const envName = node.name.toLowerCase();

        // Skip wrapfigure if not included
        if (envName === 'wrapfigure' && !include_wrapfigures) {
          continue;
        }

        if (FIGURE_ENVS.has(envName)) {
          // Extract from both content AND args (latex-utensils may put
          // leading groups like {\epsfig{...}} into args instead of content)
          const allNodes = [
            ...node.content,
            ...extractNodesFromArgs(node.args),
          ];
          
          const graphics = extractIncludegraphics(allNodes, custom_graphics_macros);
          const nonStdGraphics = extractNonStandardGraphics(allNodes);
          const subfigures = include_subfigures
            ? extractSubfigures(allNodes)
            : [];

          // Get placement from environment args
          let placement: string | undefined;
          if (node.args && node.args.length > 0) {
            const firstArg = node.args[0];
            if (latexParser.isOptionalArg(firstArg)) {
              placement = extractText(firstArg.content);
            }
          }

          // Combine all image paths
          const allPaths = [
            ...graphics.map(g => g.path),
            ...nonStdGraphics.map(g => g.path)
          ];

          // Extract inline drawing if present (check both content and args)
          const inlineDrawing = extractInlineDrawing(allNodes);

          const figure: Figure = {
            label: extractLabel(node.content),
            caption: extractCaption(node.content),
            image_paths: allPaths,
            placement,
            section: sectionStack.length > 0 ? sectionStack[sectionStack.length - 1]!.title : undefined,
            section_path: sectionStack.map(s => s.title).filter(Boolean),
            is_subfigure: subfigures.length > 0,
            width: graphics[0]?.width,
            location: nodeToLocator(node, file),
          };

          // Add inline drawing info if present
          if (inlineDrawing) {
            figure.drawing_type = inlineDrawing.type;
            figure.drawing_source = inlineDrawing.source;
          }

          if (subfigures.length > 0) {
            figure.subfigures = subfigures;
          }

          figures.push(figure);
        } else {
          // Recurse into non-figure environments
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
  return figures;
}
