import * as path from 'node:path';
import { blockedCommand, unsafeFs } from '@autoresearch/shared';
import type { ManifestTool } from './types.js';

const BLOCKED_COMMAND_PATTERNS = [
  { pattern: /(?:^|\s)rm\s+-rf\s+\/(?:\s|$)/i, reason: 'rm -rf /' },
  { pattern: /curl\s*\|\s*sh/i, reason: 'curl | sh' },
  { pattern: /chmod\s+777(?:\s|$)/i, reason: 'chmod 777' },
  { pattern: />\s*\/dev\//i, reason: '> /dev/' },
  { pattern: /(?:^|\s)ncat?(?:\s|$)/i, reason: 'nc/ncat' },
];

export function resolveWithinRoot(rootPath: string, candidatePath: string, label: string): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(path.isAbsolute(candidatePath) ? candidatePath : path.join(root, candidatePath));
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw unsafeFs(`${label} must stay within ${root}`, { label, root_path: root, candidate_path: candidatePath });
  }
  return resolved;
}

export function sanitizeRelativePath(relativePath: string, label: string): string {
  const normalized = relativePath.trim();
  if (!normalized) {
    throw unsafeFs(`${label} cannot be empty`, { label });
  }
  if (normalized.includes('\0') || normalized.includes('..')) {
    throw unsafeFs(`${label} contains unsafe path traversal`, { label, path: relativePath });
  }
  return normalized;
}

export function buildToolCommand(tool: ManifestTool, scriptPath: string, args: string[]): string[] {
  if (tool === 'python') return ['python3', scriptPath, ...args];
  if (tool === 'bash') return ['bash', scriptPath, ...args];
  if (tool === 'julia') return ['julia', scriptPath, ...args];
  return ['wolframscript', '-file', scriptPath, ...args];
}

export function assertCommandAllowed(argv: string[]): void {
  const command = argv.join(' ');
  for (const entry of BLOCKED_COMMAND_PATTERNS) {
    if (entry.pattern.test(command)) {
      throw blockedCommand(`Blocked command detected: ${entry.reason}`, {
        blocked_pattern: entry.reason,
        command,
      });
    }
  }
}
