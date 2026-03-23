import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

function hasAutoresearchDir(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, '.autoresearch'));
}

export function resolveLifecycleProjectRoot(projectRoot: string | null, cwd: string): string {
  if (projectRoot) {
    return path.resolve(cwd, projectRoot);
  }
  let current = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  for (let depth = 0; depth < 50; depth += 1) {
    if (current !== home && hasAutoresearchDir(current)) {
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
