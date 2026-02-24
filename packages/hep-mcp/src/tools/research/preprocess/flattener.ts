/**
 * LaTeX Flattener with Source Mapping
 * Extends projectResolver with source location tracking
 */

import * as path from 'path';
import {
  mergeProjectContent,
  analyzeProjectStructure,
  type ResolveOptions,
} from '../latex/projectResolver.js';
import type { SourceMap, SourceLocation } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FlattenResult {
  /** Flattened content */
  content: string;
  /** Source map for line tracking */
  sourceMap: SourceMap;
  /** Number of files merged */
  filesMerged: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten a LaTeX project with source mapping
 * Reuses projectResolver for file merging, adds SourceMap tracking
 */
export function flattenLatexProject(
  mainFilePath: string,
  options: ResolveOptions = {}
): FlattenResult {
  // Use existing projectResolver for merging
  const content = mergeProjectContent(mainFilePath, options);
  const structure = analyzeProjectStructure(mainFilePath, options);

  // Build source map by analyzing the merged content
  const sourceMap = buildSourceMap(mainFilePath, structure.files.map(f => f.path));

  return {
    content,
    sourceMap,
    filesMerged: structure.files.length,
  };
}

/**
 * Build source map from project structure
 * Note: This is a simplified version - for precise mapping,
 * we'd need to track positions during merging
 */
function buildSourceMap(mainFile: string, sourceFiles: string[]): SourceMap {
  const lineMap = new Map<number, SourceLocation>();

  // For now, map all lines to main file
  // TODO: Enhance projectResolver to track line mappings during merge
  return {
    lineMap,
    sourceFiles,
    mainFile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Source Map Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look up original source location for a flattened line number
 */
export function lookupSourceLocation(
  sourceMap: SourceMap,
  flattenedLine: number
): SourceLocation | null {
  return sourceMap.lineMap.get(flattenedLine) || null;
}

/**
 * Get relative path from main file
 */
export function getRelativePath(sourceMap: SourceMap, filePath: string): string {
  const mainDir = path.dirname(sourceMap.mainFile);
  return path.relative(mainDir, filePath);
}

/**
 * Format source location as string
 */
export function formatSourceLocation(
  loc: SourceLocation,
  sourceMap?: SourceMap
): string {
  const file = sourceMap ? getRelativePath(sourceMap, loc.file) : loc.file;
  return `${file}:${loc.line}`;
}
