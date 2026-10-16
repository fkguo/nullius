import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` (pass `import.meta.url`) is the script Node was started with.
 *
 * Node resolves symlinks when it builds the main module's URL, but `process.argv[1]` keeps the
 * path as typed. A guard that compares `path.resolve(process.argv[1])` with the module path is
 * therefore false whenever the process is started through a symlink — an npm bin link, a
 * symlinked checkout, or `/tmp` on macOS — and an MCP server behind such a guard exits 0 with
 * no output instead of starting. Both sides are compared through `realpath` here. When
 * `realpath` throws (the argument names no file), the plain resolved comparison is the
 * fallback. A process without `argv[1]` (REPL, `-e`) is never the main script, and a module
 * preloaded with `--import` is not the file `argv[1]` names, so it is not the main script either.
 *
 * `argv1` is a parameter only so that tests can drive the comparison without re-spawning.
 */
export function isMainModule(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    // Not a file: URL (a bundler or loader scheme): never the script Node was started with.
    return false;
  }
  try {
    return realpathSync(argv1) === realpathSync(modulePath);
  } catch {
    return path.resolve(argv1) === modulePath;
  }
}
