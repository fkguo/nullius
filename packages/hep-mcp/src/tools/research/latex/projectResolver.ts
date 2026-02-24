/**
 * LaTeX Multi-File Project Resolver
 * Handles subfiles, standalone, import packages for complex LaTeX projects
 */

import * as fs from 'fs';
import * as path from 'path';
import { readFileWithEncoding } from './parser.js';
import type { SourceMap, SourceSpan } from './locator.js';
import { isPathInside } from '../../../data/pathGuard.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectFile {
  /** Absolute file path */
  path: string;
  /** File role in project */
  role: 'main' | 'chapter' | 'section' | 'figure' | 'table' | 'appendix' | 'other';
  /** Include command that referenced this file */
  includeType?: 'input' | 'include' | 'subfile' | 'standalone' | 'import' | 'subimport';
  /** Parent file that includes this one */
  parent?: string;
}

export interface ProjectStructure {
  /** Main .tex file */
  mainFile: string;
  /** All project files */
  files: ProjectFile[];
  /** Detected packages */
  packages: string[];
  /** Project base directory */
  baseDir: string;
}

export interface ResolveOptions {
  /** Maximum recursion depth (default: 10) */
  maxDepth?: number;
  /** Follow subfile includes (default: true) */
  resolveSubfiles?: boolean;
  /** Follow standalone includes (default: true) */
  resolveStandalone?: boolean;
  /** Follow import/subimport (default: true) */
  resolveImport?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect used packages from LaTeX content
 */
export function detectPackages(content: string): string[] {
  const packages: string[] = [];
  const regex = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    // Handle comma-separated packages
    const pkgs = match[1].split(',').map(p => p.trim());
    packages.push(...pkgs);
  }
  return [...new Set(packages)];
}

/**
 * Infer file role from filename and content
 */
function inferFileRole(filePath: string, content: string): ProjectFile['role'] {
  const basename = path.basename(filePath, '.tex').toLowerCase();

  // Check filename patterns
  if (basename === 'main' || basename === 'paper' || basename === 'article') {
    return 'main';
  }
  if (/^(chapter|chap|ch)\d*/.test(basename)) {
    return 'chapter';
  }
  if (/^(section|sec)\d*/.test(basename)) {
    return 'section';
  }
  if (/^(appendix|app)[a-z]?$/.test(basename)) {
    return 'appendix';
  }
  if (/^(fig|figure)/.test(basename)) {
    return 'figure';
  }
  if (/^(tab|table)/.test(basename)) {
    return 'table';
  }

  // Check content patterns
  if (/\\documentclass/.test(content) && /\\begin\{document\}/.test(content)) {
    return 'main';
  }
  if (/\\chapter\{/.test(content)) {
    return 'chapter';
  }
  // Section file: has \section but no \chapter
  if (/\\section\{/.test(content) && !/\\chapter\{/.test(content)) {
    return 'section';
  }

  return 'other';
}

/**
 * Resolve file path with .tex extension
 */
function resolveTexPath(basePath: string, includePath: string): string | null {
  // Security: disallow absolute includes
  if (path.isAbsolute(includePath)) return null;

  // Try as-is first
  let resolved = path.resolve(basePath, includePath);
  if (fs.existsSync(resolved)) return resolved;

  // Try with .tex extension
  if (!resolved.endsWith('.tex')) {
    resolved = resolved + '.tex';
    if (fs.existsSync(resolved)) return resolved;
  }

  return null;
}

function isSafeProjectFile(projectRoot: string, candidatePath: string): boolean {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(candidatePath);
  if (!isPathInside(root, candidate)) return false;
  try {
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink()) return false;
    return st.isFile();
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Include Pattern Extractors
// ─────────────────────────────────────────────────────────────────────────────

interface IncludeMatch {
  type: ProjectFile['includeType'];
  path: string;
  importDir?: string; // For \import{dir}{file}
}

/**
 * Extract all include commands from content
 */
function extractIncludes(content: string): IncludeMatch[] {
  const includes: IncludeMatch[] = [];

  // \input{file} and \include{file}
  const basicRegex = /\\(input|include)\{([^}]+)\}/g;
  let match;
  while ((match = basicRegex.exec(content)) !== null) {
    includes.push({
      type: match[1] as 'input' | 'include',
      path: match[2],
    });
  }

  // \subfile{file} (subfiles package)
  const subfileRegex = /\\subfile\{([^}]+)\}/g;
  while ((match = subfileRegex.exec(content)) !== null) {
    includes.push({ type: 'subfile', path: match[1] });
  }

  // \includestandalone{file} (standalone package)
  const standaloneRegex = /\\includestandalone(?:\[[^\]]*\])?\{([^}]+)\}/g;
  while ((match = standaloneRegex.exec(content)) !== null) {
    includes.push({ type: 'standalone', path: match[1] });
  }

  // \import{dir}{file} (import package)
  const importRegex = /\\import\{([^}]*)\}\{([^}]+)\}/g;
  while ((match = importRegex.exec(content)) !== null) {
    includes.push({
      type: 'import',
      importDir: match[1],
      path: match[2],
    });
  }

  // \subimport{dir}{file} (import package)
  const subimportRegex = /\\subimport\{([^}]*)\}\{([^}]+)\}/g;
  while ((match = subimportRegex.exec(content)) !== null) {
    includes.push({
      type: 'subimport',
      importDir: match[1],
      path: match[2],
    });
  }

  return includes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze project structure starting from main file
 */
export function analyzeProjectStructure(
  mainFilePath: string,
  options: ResolveOptions = {}
): ProjectStructure {
  const {
    maxDepth = 10,
    resolveSubfiles = true,
    resolveStandalone = true,
    resolveImport = true,
  } = options;

  // Check file exists
  if (!fs.existsSync(mainFilePath)) {
    throw new Error(`Main file not found: ${mainFilePath}`);
  }

  const baseDir = path.dirname(mainFilePath);
  const visited = new Set<string>();
  const files: ProjectFile[] = [];

  // Read main file with error handling
  let mainContent: string;
  try {
    mainContent = readFileWithEncoding(mainFilePath);
  } catch (err) {
    throw new Error(`Failed to read main file: ${mainFilePath}`);
  }
  const packages = detectPackages(mainContent);

  // Add main file
  files.push({
    path: mainFilePath,
    role: 'main',
  });
  visited.add(mainFilePath);

  // Recursive function to process includes
  function processFile(filePath: string, depth: number, parentPath?: string) {
    if (depth <= 0) return;

    let content: string;
    try {
      content = readFileWithEncoding(filePath);
    } catch {
      // Skip unreadable files
      return;
    }
    const includes = extractIncludes(content);
    const fileDir = path.dirname(filePath);

    for (const inc of includes) {
      // Skip based on options
      if (inc.type === 'subfile' && !resolveSubfiles) continue;
      if (inc.type === 'standalone' && !resolveStandalone) continue;
      if ((inc.type === 'import' || inc.type === 'subimport') && !resolveImport) continue;

      // Resolve path
      let resolvedPath: string | null = null;

      if (inc.type === 'import') {
        // \import uses absolute path from baseDir
        const importBase = path.resolve(baseDir, inc.importDir || '');
        if (isPathInside(baseDir, importBase)) {
          resolvedPath = resolveTexPath(importBase, inc.path);
        }
      } else if (inc.type === 'subimport') {
        // \subimport uses relative path from current file
        const importBase = path.resolve(fileDir, inc.importDir || '');
        if (isPathInside(baseDir, importBase)) {
          resolvedPath = resolveTexPath(importBase, inc.path);
        }
      } else {
        // Standard includes relative to current file
        resolvedPath = resolveTexPath(fileDir, inc.path);
      }

      if (resolvedPath && !visited.has(resolvedPath) && isSafeProjectFile(baseDir, resolvedPath)) {
        visited.add(resolvedPath);

        let incContent: string;
        try {
          incContent = readFileWithEncoding(resolvedPath);
        } catch {
          // Skip unreadable files
          continue;
        }
        const role = inferFileRole(resolvedPath, incContent);

        files.push({
          path: resolvedPath,
          role,
          includeType: inc.type,
          parent: parentPath,
        });

        // Recurse
        processFile(resolvedPath, depth - 1, resolvedPath);
      }
    }
  }

  // Start processing from main file
  processFile(mainFilePath, maxDepth, mainFilePath);

  return {
    mainFile: mainFilePath,
    files,
    packages,
    baseDir,
  };
}

/**
 * Merge all project files into single content string
 * Handles subfile/standalone preamble stripping
 */
export function mergeProjectContent(
  mainFilePath: string,
  options: ResolveOptions = {}
): string {
  return mergeProjectContentWithSourceMap(mainFilePath, options).merged;
}

export interface MergeProjectContentWithSourceMapResult {
  merged: string;
  sourceMap: SourceMap;
}

/**
 * Merge all project files into single content string, with a SourceMap that can
 * map any offset in the merged content back to the original file + local offset.
 */
export function mergeProjectContentWithSourceMap(
  mainFilePath: string,
  options: ResolveOptions = {}
): MergeProjectContentWithSourceMapResult {
  const {
    maxDepth = 10,
    resolveSubfiles = true,
    resolveStandalone = true,
    resolveImport = true,
  } = options;

  const baseDir = path.dirname(mainFilePath);
  const visited = new Set<string>();

  function appendSpan(map: SourceMap, span: SourceSpan): void {
    if (span.globalStart >= span.globalEnd) return;
    const last = map[map.length - 1];
    if (
      last &&
      last.file === span.file &&
      last.globalEnd === span.globalStart &&
      last.localStart + (last.globalEnd - last.globalStart) === span.localStart
    ) {
      last.globalEnd = span.globalEnd;
      return;
    }
    map.push(span);
  }

  function stripSubfilePreambleWithOffset(content: string): { body: string; startOffset: number } {
    const docMatch = content.match(/(\\begin\{document\})([\s\S]*?)\\end\{document\}/);
    if (!docMatch || docMatch.index === undefined) {
      return { body: content, startOffset: 0 };
    }
    return {
      body: docMatch[2],
      startOffset: docMatch.index + docMatch[1].length,
    };
  }

  const includeRegex =
    /\\(input|include)\{([^}]+)\}|\\subfile\{([^}]+)\}|\\includestandalone(?:\[[^\]]*\])?\{([^}]+)\}|\\import\{([^}]*)\}\{([^}]+)\}|\\subimport\{([^}]*)\}\{([^}]+)\}/g;

  type IncludeWithRange = {
    raw: string;
    start: number;
    end: number;
    type: ProjectFile['includeType'];
    path: string;
    importDir?: string;
  };

  function extractIncludesWithRanges(content: string): IncludeWithRange[] {
    const matches: IncludeWithRange[] = [];
    let match: RegExpExecArray | null;
    while ((match = includeRegex.exec(content)) !== null) {
      const raw = match[0];
      const start = match.index;
      const end = match.index + raw.length;

      // \input{file} or \include{file}
      if (match[1] && match[2]) {
        matches.push({
          raw,
          start,
          end,
          type: match[1] as 'input' | 'include',
          path: match[2],
        });
        continue;
      }

      // \subfile{file}
      if (match[3]) {
        matches.push({
          raw,
          start,
          end,
          type: 'subfile',
          path: match[3],
        });
        continue;
      }

      // \includestandalone{file}
      if (match[4]) {
        matches.push({
          raw,
          start,
          end,
          type: 'standalone',
          path: match[4],
        });
        continue;
      }

      // \import{dir}{file}
      if (match[6] !== undefined) {
        matches.push({
          raw,
          start,
          end,
          type: 'import',
          importDir: match[5] || '',
          path: match[6],
        });
        continue;
      }

      // \subimport{dir}{file}
      if (match[8] !== undefined) {
        matches.push({
          raw,
          start,
          end,
          type: 'subimport',
          importDir: match[7] || '',
          path: match[8],
        });
      }
    }
    return matches;
  }

  function mergeFile(
    filePath: string,
    includeType?: ProjectFile['includeType'],
    depth = maxDepth
  ): MergeProjectContentWithSourceMapResult {
    if (depth <= 0) return { merged: '', sourceMap: [] };
    if (visited.has(filePath)) return { merged: '', sourceMap: [] };
    visited.add(filePath);

    let original: string;
    try {
      original = readFileWithEncoding(filePath);
    } catch {
      return { merged: '', sourceMap: [] };
    }

    const fileDir = path.dirname(filePath);
    let content = original;
    let contentBaseOffset = 0;

    if (includeType === 'subfile' || includeType === 'standalone') {
      const stripped = stripSubfilePreambleWithOffset(original);
      content = stripped.body;
      contentBaseOffset = stripped.startOffset;
    }

    const includes = extractIncludesWithRanges(content);
    const sourceMap: SourceMap = [];

    let merged = '';
    let globalCursor = 0;

    const appendText = (text: string, localStartInContent: number) => {
      if (text.length === 0) return;
      const start = globalCursor;
      merged += text;
      globalCursor += text.length;
      appendSpan(sourceMap, {
        globalStart: start,
        globalEnd: globalCursor,
        file: filePath,
        localStart: contentBaseOffset + localStartInContent,
      });
    };

    const appendSourceMap = (child: SourceMap) => {
      for (const span of child) {
        appendSpan(sourceMap, {
          globalStart: span.globalStart + globalCursor,
          globalEnd: span.globalEnd + globalCursor,
          file: span.file,
          localStart: span.localStart,
        });
      }
    };

    let localCursor = 0;
    for (const inc of includes) {
      // Keep text before include
      appendText(content.slice(localCursor, inc.start), localCursor);

      const shouldResolve =
        !(
          (inc.type === 'subfile' && !resolveSubfiles) ||
          (inc.type === 'standalone' && !resolveStandalone) ||
          ((inc.type === 'import' || inc.type === 'subimport') && !resolveImport)
        );

      let resolvedPath: string | null = null;
      if (shouldResolve) {
        if (inc.type === 'import') {
          const importBase = path.resolve(baseDir, inc.importDir || '');
          if (isPathInside(baseDir, importBase)) {
            resolvedPath = resolveTexPath(importBase, inc.path);
          }
        } else if (inc.type === 'subimport') {
          const importBase = path.resolve(fileDir, inc.importDir || '');
          if (isPathInside(baseDir, importBase)) {
            resolvedPath = resolveTexPath(importBase, inc.path);
          }
        } else {
          resolvedPath = resolveTexPath(fileDir, inc.path);
        }
      }

      if (resolvedPath && !visited.has(resolvedPath) && isSafeProjectFile(baseDir, resolvedPath)) {
        const child = mergeFile(resolvedPath, inc.type, depth - 1);
        if (child.merged.length > 0) {
          merged += child.merged;
          appendSourceMap(child.sourceMap);
          globalCursor += child.merged.length;
        }
      } else {
        // Unresolved include: keep original command in merged output
        appendText(inc.raw, inc.start);
      }

      localCursor = inc.end;
    }

    // Append remaining text
    appendText(content.slice(localCursor), localCursor);

    return { merged, sourceMap };
  }

  return mergeFile(mainFilePath);
}
