import { latexParser } from 'latex-utensils';

import type { LatexNode } from './parser.js';
import { scanPreambleForMacros, type UserMacroRegistry } from './parserHarness.js';

export interface MacroWrappedEnvironmentPairs {
  beginToEnv: Map<string, string>;
  beginToEnd: Map<string, string>;
}

export interface MacroWrappedEnvironmentMatch {
  beginIndex: number;
  endIndex: number;
  beginNode: LatexNode;
  endNode: LatexNode;
  beginMacro: string;
  endMacro: string;
  envName: string;
}

function envNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function getRegistryBeginMacros(registry: UserMacroRegistry): Map<string, string> {
  if (registry.environmentBeginMacros.size > 0) return registry.environmentBeginMacros;

  const fallback = new Map<string, string>();
  for (const [macroName, envName] of registry.environmentMacros.entries()) {
    if (macroName.startsWith('b')) fallback.set(macroName, envName);
  }
  return fallback;
}

function getRegistryEndMacros(registry: UserMacroRegistry): Map<string, string> {
  if (registry.environmentEndMacros.size > 0) return registry.environmentEndMacros;

  const fallback = new Map<string, string>();
  for (const [macroName, envName] of registry.environmentMacros.entries()) {
    if (macroName.startsWith('e')) fallback.set(macroName, envName);
  }
  return fallback;
}

function inferEndMacroName(beginMacro: string): string | null {
  if (!beginMacro.startsWith('b')) return null;
  if (beginMacro.length < 2) return null;
  return `e${beginMacro.slice(1)}`;
}

export function buildMacroWrappedEnvironmentPairsFromRegistry(
  registry: UserMacroRegistry,
  options?: { allowedEnvNames?: Set<string> }
): MacroWrappedEnvironmentPairs {
  const beginMacros = getRegistryBeginMacros(registry);
  const endMacros = getRegistryEndMacros(registry);

  const beginToEnv = new Map<string, string>();
  const beginToEnd = new Map<string, string>();

  const allowed = options?.allowedEnvNames;

  for (const [beginMacro, envNameRaw] of beginMacros.entries()) {
    const envName = envNameRaw.trim();
    if (!envName) continue;
    if (allowed && !allowed.has(envNameKey(envName))) continue;

    const predictedEnd = inferEndMacroName(beginMacro);
    const predictedMatchesEnv = predictedEnd ? envNameKey(endMacros.get(predictedEnd) ?? '') === envNameKey(envName) : false;
    const endCandidateList = Array.from(endMacros.entries())
      .filter(([, candidateEnv]) => envNameKey(candidateEnv) === envNameKey(envName))
      .map(([name]) => name);

    const endMacro =
      (predictedEnd && endMacros.has(predictedEnd) && (predictedMatchesEnv || endMacros.get(predictedEnd) === envName) ? predictedEnd : null) ??
      (endCandidateList.length === 1 ? endCandidateList[0]! : null) ??
      predictedEnd;

    if (!endMacro) continue;

    beginToEnv.set(beginMacro, envName);
    beginToEnd.set(beginMacro, endMacro);
  }

  return { beginToEnv, beginToEnd };
}

export function buildMacroWrappedEnvironmentPairsFromContent(
  content: string,
  options?: { allowedEnvNames?: Set<string> }
): MacroWrappedEnvironmentPairs {
  const registry = scanPreambleForMacros(content);
  return buildMacroWrappedEnvironmentPairsFromRegistry(registry, options);
}

export function matchMacroWrappedEnvironmentAt(
  nodes: LatexNode[],
  startIndex: number,
  pairs: MacroWrappedEnvironmentPairs
): MacroWrappedEnvironmentMatch | null {
  const startNode = nodes[startIndex];
  if (!startNode || !latexParser.isCommand(startNode)) return null;

  const beginMacro = startNode.name;
  const endMacro = pairs.beginToEnd.get(beginMacro);
  const envName = pairs.beginToEnv.get(beginMacro);
  if (!endMacro || !envName) return null;

  const stack: Array<{ beginMacro: string; endMacro: string }> = [{ beginMacro, endMacro }];

  for (let i = startIndex + 1; i < nodes.length; i++) {
    const node = nodes[i];
    if (!latexParser.isCommand(node)) continue;

    const name = node.name;
    const nestedEnd = pairs.beginToEnd.get(name);
    if (nestedEnd) {
      stack.push({ beginMacro: name, endMacro: nestedEnd });
      continue;
    }

    const top = stack[stack.length - 1];
    if (top && name === top.endMacro) {
      stack.pop();
      if (stack.length === 0) {
        return {
          beginIndex: startIndex,
          endIndex: i,
          beginNode: startNode,
          endNode: node,
          beginMacro,
          endMacro: name,
          envName,
        };
      }
    }
  }

  return null;
}

