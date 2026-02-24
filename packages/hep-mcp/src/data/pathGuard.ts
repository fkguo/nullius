import * as fs from 'fs';
import * as path from 'path';
import { unsafeFs } from '@autoresearch/shared';

function isOutsideOf(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return relative === '..' || relative.startsWith(`..${path.sep}`);
}

export function isPathInside(parentDir: string, candidatePath: string): boolean {
  const resolvedParent = path.resolve(parentDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedParent === resolvedCandidate) return true;
  if (isOutsideOf(resolvedParent, resolvedCandidate)) return false;
  return !path.isAbsolute(path.relative(resolvedParent, resolvedCandidate));
}

export function resolvePathWithinParent(
  parentDir: string,
  userPath: string,
  what: string
): string {
  const resolvedParent = path.resolve(parentDir);
  const resolvedCandidate = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(resolvedParent, userPath);

  if (!isPathInside(resolvedParent, resolvedCandidate)) {
    throw unsafeFs(`${what} must be within ${resolvedParent}`, {
      parent_dir: resolvedParent,
      candidate_path: resolvedCandidate,
    });
  }

  // Defense-in-depth: block symlink escapes.
  // If a path component inside `resolvedParent` is a symlink pointing outside,
  // `path.resolve()` + string-based checks are insufficient.
  if (fs.existsSync(resolvedParent)) {
    let realParent: string;
    try {
      realParent = fs.realpathSync(resolvedParent);
    } catch {
      realParent = resolvedParent;
    }

    // Resolve the nearest existing ancestor of the candidate to validate realpath containment.
    let existing = resolvedCandidate;
    while (!fs.existsSync(existing)) {
      const next = path.dirname(existing);
      if (next === existing) break;
      existing = next;
    }

    if (fs.existsSync(existing)) {
      let realExisting: string;
      try {
        realExisting = fs.realpathSync(existing);
      } catch {
        realExisting = existing;
      }

      if (!isPathInside(realParent, realExisting)) {
        throw unsafeFs(`${what} must be within ${realParent}`, {
          parent_dir: realParent,
          candidate_path: resolvedCandidate,
          existing_path: existing,
          existing_realpath: realExisting,
        });
      }
    }
  }

  return resolvedCandidate;
}
