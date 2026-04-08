import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_POLICY_REAL_PROJECT = 'real_project';

function devRepoRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../../..');
}

function isWithin(candidate: string, base: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedBase = path.resolve(base);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function maintainerFixtureRoots(repoRoot: string): string[] {
  return [
    path.join(repoRoot, 'skills', 'research-team', '.tmp'),
  ];
}

function policyViolationMessage(label: string, candidate: string, repoRoot: string, policy: string): string {
  if (policy === PROJECT_POLICY_REAL_PROJECT) {
    return `${label} must resolve outside the autoresearch-lab dev repo for real projects.\npath=${candidate}\nrepo_root=${repoRoot}`;
  }
  const allowed = maintainerFixtureRoots(repoRoot).join(', ');
  return `${label} is repo-internal but not under an allowed maintainer_fixture directory.\npath=${candidate}\nrepo_root=${repoRoot}\nallowed=${allowed}`;
}

export function resolveUserPath(rawPath: string, base: string): string {
  const expanded = rawPath === '~'
    ? os.homedir()
    : rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(2))
      : rawPath;
  return path.resolve(base, expanded);
}

export function assertProjectRootAllowed(
  projectRoot: string,
  policy = PROJECT_POLICY_REAL_PROJECT,
  repoRoot = devRepoRoot(),
): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedRepoRoot = path.resolve(repoRoot);
  if (!isWithin(resolvedRoot, resolvedRepoRoot)) {
    return resolvedRoot;
  }
  if (policy !== PROJECT_POLICY_REAL_PROJECT) {
    for (const allowedRoot of maintainerFixtureRoots(resolvedRepoRoot)) {
      if (isWithin(resolvedRoot, allowedRoot)) {
        return resolvedRoot;
      }
    }
  }
  throw new Error(policyViolationMessage('project root', resolvedRoot, resolvedRepoRoot, policy));
}
