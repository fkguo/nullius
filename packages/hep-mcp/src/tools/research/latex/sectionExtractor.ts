/**
 * LaTeX Section Extractor
 * Extracts document structure from LaTeX AST
 */

import { latexParser } from 'latex-utensils';
import type { LatexAst, LatexNode } from './parser.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Section {
  level: number;
  title: string;
  number?: string;
  content?: string;
  children: Section[];
}

export interface DocumentStructure {
  title: string;
  authors: string[];
  abstract: string;
  sections: Section[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_LEVELS: Record<string, number> = {
  'part': 0,
  'chapter': 1,
  'section': 1,
  'subsection': 2,
  'subsubsection': 3,
  'paragraph': 4,
  'subparagraph': 5,
};

/**
 * Extract text content from AST nodes
 */
export function extractText(nodes: LatexNode[]): string {
  const parts: string[] = [];

  for (const node of nodes) {
    if (latexParser.isTextString(node)) {
      parts.push(node.content);
    } else if (latexParser.isGroup(node)) {
      parts.push(extractText(node.content));
    } else if (latexParser.isSpace(node) || latexParser.isSoftbreak(node)) {
      parts.push(' ');
    } else if (latexParser.isCommand(node)) {
      // Handle special commands
      if (node.name === 'textbf' || node.name === 'textit' || node.name === 'emph') {
        if (node.args.length > 0 && latexParser.isGroup(node.args[0])) {
          parts.push(extractText(node.args[0].content));
        }
      }
    }
  }

  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Get command argument as text
 */
function getCommandArg(node: LatexNode, argIndex = 0): string {
  if (!latexParser.isCommand(node)) return '';
  const arg = node.args[argIndex];
  if (!arg || !latexParser.isGroup(arg)) return '';
  return extractText(arg.content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively search for a command in AST nodes
 */
function findCommandRecursive(nodes: LatexNode[], commandName: string): LatexNode | null {
  for (const node of nodes) {
    if (latexParser.isCommand(node) && node.name === commandName) {
      return node;
    }
    // Recursively search in environments (e.g., document environment)
    if (latexParser.isEnvironment(node)) {
      const found = findCommandRecursive(node.content, commandName);
      if (found) return found;
    }
    // Recursively search in groups
    if (latexParser.isGroup(node)) {
      const found = findCommandRecursive(node.content, commandName);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Recursively search for an environment in AST nodes
 */
function findEnvironmentRecursive(nodes: LatexNode[], envName: string): LatexNode | null {
  for (const node of nodes) {
    if (latexParser.isEnvironment(node) && node.name === envName) {
      return node;
    }
    // Recursively search in nested environments
    if (latexParser.isEnvironment(node)) {
      const found = findEnvironmentRecursive(node.content, envName);
      if (found) return found;
    }
    // Recursively search in groups
    if (latexParser.isGroup(node)) {
      const found = findEnvironmentRecursive(node.content, envName);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extract title from AST (searches recursively, including inside document environment)
 */
export function extractTitle(ast: LatexAst): string {
  if (ast.kind !== 'ast.root') return '';

  const titleNode = findCommandRecursive(ast.content, 'title');
  if (titleNode && latexParser.isCommand(titleNode)) {
    return getCommandArg(titleNode);
  }
  return '';
}

/**
 * Extract authors from AST (searches recursively, including inside document environment)
 */
export function extractAuthors(ast: LatexAst): string[] {
  if (ast.kind !== 'ast.root') return [];

  const authors: string[] = [];
  
  // Find all \author commands recursively
  function collectAuthors(nodes: LatexNode[]) {
    for (const node of nodes) {
      if (latexParser.isCommand(node) && node.name === 'author') {
        const authorText = getCommandArg(node);
        if (authorText) {
          // Each \author command represents one author (or multiple authors separated by "and")
          // Split by "and" to handle cases like "Author1 and Author2" in a single command
          const parts = authorText.split(/\s+and\s+/i);
          for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.length > 0) {
              authors.push(trimmed);
            }
          }
        }
      }
      // Recursively search in environments
      if (latexParser.isEnvironment(node)) {
        collectAuthors(node.content);
      }
      // Recursively search in groups
      if (latexParser.isGroup(node)) {
        collectAuthors(node.content);
      }
    }
  }
  
  collectAuthors(ast.content);
  
  return authors;
}

/**
 * Extract abstract from AST (searches recursively, including inside document environment)
 */
export function extractAbstract(ast: LatexAst): string {
  if (ast.kind !== 'ast.root') return '';

  const abstractNode = findEnvironmentRecursive(ast.content, 'abstract');
  if (abstractNode && latexParser.isEnvironment(abstractNode)) {
    return extractText(abstractNode.content);
  }
  return '';
}

export interface ExtractSectionsOptions {
  /** Include section content */
  includeContent?: boolean;
  /** Max content length per section */
  maxContentLength?: number;
}

/**
 * Extract sections from AST with optional content
 */
export function extractSectionsWithContent(
  ast: LatexAst,
  options: ExtractSectionsOptions = {}
): Section[] {
  if (ast.kind !== 'ast.root') return [];

  const { includeContent = false, maxContentLength = 0 } = options;
  const sections: Section[] = [];
  const stack: Section[] = [];

  // Find document environment
  let docContent: LatexNode[] = ast.content;
  for (const node of ast.content) {
    if (latexParser.isEnvironment(node) && node.name === 'document') {
      docContent = node.content;
      break;
    }
  }

  // Track section boundaries for content extraction
  const sectionIndices: { section: Section; startIdx: number }[] = [];

  for (let i = 0; i < docContent.length; i++) {
    const node = docContent[i];
    if (!latexParser.isCommand(node)) continue;

    const level = SECTION_LEVELS[node.name];
    if (level === undefined) continue;

    const section: Section = {
      level,
      title: getCommandArg(node),
      children: [],
    };

    // Find parent section
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    if (stack.length === 0) {
      sections.push(section);
    } else {
      stack[stack.length - 1].children.push(section);
    }

    stack.push(section);
    sectionIndices.push({ section, startIdx: i + 1 });
  }

  // Extract content if requested
  if (includeContent && sectionIndices.length > 0) {
    for (let i = 0; i < sectionIndices.length; i++) {
      const { section, startIdx } = sectionIndices[i];
      const endIdx = i + 1 < sectionIndices.length
        ? sectionIndices[i + 1].startIdx - 1
        : docContent.length;

      const contentNodes = docContent.slice(startIdx, endIdx);
      let content = extractText(contentNodes);

      // Truncate if maxContentLength > 0 (0 or negative means no limit)
      if (maxContentLength > 0 && content.length > maxContentLength) {
        content = content.slice(0, maxContentLength) + '...';
      }

      if (content) {
        section.content = content;
      }
    }
  }

  return sections;
}

/**
 * Extract sections from AST
 */
export function extractSections(ast: LatexAst): Section[] {
  return extractSectionsWithContent(ast, { includeContent: false });
}

/**
 * Extract complete document structure
 */
export function extractDocumentStructure(ast: LatexAst): DocumentStructure {
  return {
    title: extractTitle(ast),
    authors: extractAuthors(ast),
    abstract: extractAbstract(ast),
    sections: extractSections(ast),
  };
}
