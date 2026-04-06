import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function looksLikeProjectRoot(candidate: string): boolean {
  const autoresearchDir = path.join(candidate, '.autoresearch');
  if (!fs.existsSync(autoresearchDir) || !fs.statSync(autoresearchDir).isDirectory()) {
    return false;
  }
  const initMarker = path.join(autoresearchDir, '.initialized');
  const hasState = fs.existsSync(path.join(autoresearchDir, 'state.json'));
  const hasPolicy = fs.existsSync(path.join(autoresearchDir, 'approval_policy.json'));
  const hasLedger = fs.existsSync(path.join(autoresearchDir, 'ledger.jsonl'));
  if (fs.existsSync(initMarker)) {
    if (!hasState && !hasPolicy) return false;
  } else if (!hasState || (!hasPolicy && !hasLedger)) {
    return false;
  }
  for (const marker of ['project_charter.md', 'AGENTS.md', 'docs', 'specs', 'artifacts', '.git']) {
    if (fs.existsSync(path.join(candidate, marker))) return true;
  }
  return false;
}

export function resolveLifecycleProjectRoot(projectRoot: string | null, cwd: string): string {
  if (projectRoot) {
    return path.resolve(cwd, projectRoot);
  }
  let current = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  for (let depth = 0; depth < 50; depth += 1) {
    if (current !== home && looksLikeProjectRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return path.resolve(cwd);
}
