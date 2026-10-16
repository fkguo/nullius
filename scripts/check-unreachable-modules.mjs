#!/usr/bin/env node
// Unreachable-module anti-drift.
//
// A source module that no declared package entry reaches is dead weight: it still
// builds, still carries tests, and still reads as if it were part of what the package
// does, while nothing can call it. Such modules pile up when a caller is deleted and
// the callee is left behind. This check walks the static relative imports of a
// package from the entries it declares in package.json (`main`, `module`, `types`,
// `bin`, every string leaf of `exports`) and fails when a module under the package's
// source root is not reached and is not on the package's explicit allowlist.
//
// What counts as an import (parsed with the TypeScript compiler, so comments and
// strings cannot fake or hide one): `import`/`export ... from`, side-effect `import`,
// `import x = require()`, `import()` calls and `import()` types, each with a literal
// relative specifier. Calls to a function named `require` are not followed: the name
// can be any local binding, so such a call proves no module edge. In an enforced
// package, a `require()` with a relative or non-literal argument, and an `import()`
// whose argument is not a literal, are reported as failures rather than trusted.
//
// Specifier resolution follows the package's own build layout, read from its
// tsconfig.json with the TypeScript parser (so `extends` and comments are honoured):
// a path under `outDir` (e.g. `./dist/index.js` in package.json or a `bin/` launcher)
// is mapped to the matching source file under `rootDir`, and the `.js`/`.mjs`/`.cjs`
// spellings resolve to their `.ts`/`.mts`/`.cts` sources (or a hand-written
// declaration file).
//
// Files that are not part of the source graph are neither candidates nor carriers:
// declaration files (`.d.ts`), test files (`*.test.*`, `*.spec.*`) and anything under a
// `__tests__`, `__mocks__` or `__fixtures__` directory are never reported, and when one
// is reached its own imports are not followed, so it cannot make another module look
// used. A declared entry or allowlisted file is always followed, whatever its name, and
// so is a reached file without an extension (such as a launcher wrapper).
//
// A module that is started some other way is invisible to an import walk: a file a
// shell script or a test suite runs, or one started as a separate process or worker
// by its path. Such a module goes on the package's allowlist, one file per entry, with
// the reason. Allowlist entries are additional roots, not exemptions: whatever an
// entry imports counts as reached, and a file it does not reach still fails. An entry
// that names no source module fails the check, so the list cannot outlive what it
// names.
//
// Usage:
//   node scripts/check-unreachable-modules.mjs            enforce the packages below
//   node scripts/check-unreachable-modules.mjs --report   also list every other package's count
//   node scripts/check-unreachable-modules.mjs --report --verbose   ...and name the modules

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRepoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Packages held to the check, keyed by repo-relative directory. Each allowlist entry is
// one source file, relative to the package directory.
export const ENFORCED_PACKAGES = {
  'packages/hep-mcp': {
    allow: [
      // Evaluation substrate: driven by tests/eval/*.test.ts (vitest), not by the MCP
      // server. Kept as the designated place for semantic-quality evaluation; its other
      // modules must be reached from this entry point.
      { path: 'src/eval/index.ts', reason: 'evaluation substrate run by tests/eval' },
    ],
  },
};

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const EXCLUDED_DIRECTORIES = new Set(['__tests__', '__mocks__', '__fixtures__', 'node_modules']);
const RESOLUTION_ALTERNATIVES = {
  '.js': ['.ts', '.tsx', '.js', '.jsx', '.d.ts'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs', '.d.mts'],
  '.cjs': ['.cts', '.cjs', '.d.cts'],
};
// TypeScript's "no inputs were found" diagnostic: irrelevant to reading rootDir/outDir.
const TSCONFIG_NO_INPUTS = 18003;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function loadTypeScript(repoRoot) {
  // The root manifest does not depend on typescript; every TypeScript workspace package
  // does, so borrow it from the first one that resolves it.
  const packagesDir = path.join(repoRoot, 'packages');
  const candidates = existsSync(packagesDir) ? readdirSync(packagesDir).sort() : [];
  for (const name of candidates) {
    const manifest = path.join(packagesDir, name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      return createRequire(manifest)('typescript');
    } catch {
      // try the next package
    }
  }
  throw new Error('typescript is not resolvable from any packages/*/package.json; run pnpm install first');
}

function isCandidateModule(relPath) {
  const segments = relPath.split('/');
  if (segments.slice(0, -1).some(segment => EXCLUDED_DIRECTORIES.has(segment))) return false;
  const base = segments[segments.length - 1];
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return false;
  return SOURCE_EXTENSIONS.includes(path.posix.extname(base));
}

function isCarrier(relPath) {
  // A reached file whose imports are followed: a candidate module, or a file without an
  // extension (such as a launcher wrapper) that is not in an excluded directory.
  if (isCandidateModule(relPath)) return true;
  const segments = relPath.split('/');
  if (segments.slice(0, -1).some(segment => EXCLUDED_DIRECTORIES.has(segment))) return false;
  return path.posix.extname(segments[segments.length - 1]) === '';
}

function listSourceModules(sourceRoot) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (entry.isFile() && isCandidateModule(toPosix(path.relative(sourceRoot, full)))) {
        out.push(full);
      }
    }
  };
  if (existsSync(sourceRoot)) walk(sourceRoot);
  return out.sort();
}

function readLayout(ts, packageDir) {
  // rootDir/outDir as TypeScript reads the package's tsconfig.json (following `extends`,
  // allowing comments); a package without one is taken to ship its sources from src/.
  const tsconfigPath = path.join(packageDir, 'tsconfig.json');
  const layout = { sourceRoot: path.join(packageDir, 'src'), outRoot: null, problems: [] };
  if (!existsSync(tsconfigPath)) return layout;
  const message = diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '; ');
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    layout.problems.push(`tsconfig.json cannot be read: ${message(read.error)}`);
    return layout;
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, packageDir, undefined, tsconfigPath);
  for (const error of parsed.errors) {
    if (error.code !== TSCONFIG_NO_INPUTS) layout.problems.push(`tsconfig.json: ${message(error)}`);
  }
  if (typeof parsed.options.rootDir === 'string') layout.sourceRoot = path.resolve(parsed.options.rootDir);
  if (typeof parsed.options.outDir === 'string') layout.outRoot = path.resolve(parsed.options.outDir);
  return layout;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveTarget(target, layout) {
  // Map a build-output path back to its source, then try the source spellings.
  let p = target;
  if (layout.outRoot !== null && isWithin(p, layout.outRoot)) {
    p = path.join(layout.sourceRoot, path.relative(layout.outRoot, p));
    // A `types` entry names the emitted declaration; its source is the module itself.
    p = p.replace(/\.d\.([cm]?ts)$/, '.$1');
  }
  const ext = path.extname(p);
  const tries = [];
  if (RESOLUTION_ALTERNATIVES[ext]) {
    const stem = p.slice(0, -ext.length);
    for (const alt of RESOLUTION_ALTERNATIVES[ext]) tries.push(stem + alt);
  } else if (ext === '') {
    tries.push(p);
    for (const alt of SOURCE_EXTENSIONS) tries.push(p + alt);
    for (const alt of SOURCE_EXTENSIONS) tries.push(path.join(p, 'index' + alt));
  } else {
    tries.push(p);
  }
  return tries.find(isFile) ?? null;
}

function collectSpecifiers(ts, file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const unfollowed = [];
  const literalOf = node =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const spec = literalOf(node.moduleSpecifier);
      if (spec !== null) specifiers.push(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literalOf(node.moduleReference.expression);
      if (spec !== null) specifiers.push(spec);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = literalOf(node.arguments[0]);
        if (spec !== null) specifiers.push(spec);
        else unfollowed.push({ line: lineOf(node), what: 'an import() with a non-literal argument; its target cannot be followed' });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        // `require` may be any local binding, so the call proves no module edge.
        const spec = literalOf(node.arguments[0]);
        if (spec === null || spec.startsWith('./') || spec.startsWith('../')) {
          unfollowed.push({ line: lineOf(node), what: 'a require() call with a relative or non-literal argument, which is not followed as an import (use import or import())' });
        }
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const spec = literalOf(node.argument.literal);
      if (spec !== null) specifiers.push(spec);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, unfollowed };
}

function collectEntryPaths(manifest) {
  const out = [];
  const leaves = value => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(leaves);
    else if (value && typeof value === 'object') Object.values(value).forEach(leaves);
  };
  for (const field of ['main', 'module', 'types', 'typings', 'bin', 'exports']) leaves(manifest[field]);
  return [...new Set(out)];
}

export function scanPackage(packageDir, { allow = [], ts } = {}) {
  const typescript = ts ?? loadTypeScript(scriptRepoRoot);
  const manifestPath = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const layout = readLayout(typescript, packageDir);
  const modules = listSourceModules(layout.sourceRoot);
  const rel = p => toPosix(path.relative(packageDir, p));

  const problems = [...layout.problems];
  const roots = [];
  for (const entry of collectEntryPaths(manifest)) {
    if (entry.includes('*')) {
      problems.push(`package.json entry ${entry} is a pattern; this check does not expand patterns`);
      continue;
    }
    const resolved = resolveTarget(path.resolve(packageDir, entry), layout);
    if (resolved === null) problems.push(`package.json entry ${entry} does not resolve to a source file`);
    else roots.push(resolved);
  }
  const declaredRootCount = roots.length;
  for (const item of allow) {
    const matched = modules.find(m => rel(m) === item.path);
    if (matched === undefined) problems.push(`allowlist entry ${item.path} names no source module`);
    else roots.push(matched);
  }
  if (declaredRootCount === 0) problems.push('package.json declares no entry that resolves to a source file');

  // A declared entry or allowlisted file always carries its imports, whatever its name
  // (e.g. an extensionless `bin` launcher); any other reached file only if it is a carrier.
  const rootSet = new Set(roots);
  const reached = new Set();
  const queue = [...roots];
  const unfollowedSites = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    if (!rootSet.has(file) && !isCarrier(rel(file))) continue;
    const { specifiers, unfollowed } = collectSpecifiers(typescript, file);
    for (const { line, what } of unfollowed) unfollowedSites.push(`${rel(file)}:${line} has ${what}`);
    for (const spec of specifiers) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const target = resolveTarget(path.resolve(path.dirname(file), spec), layout);
      if (target === null) problems.push(`${rel(file)} imports ${spec}, which does not resolve to a file`);
      else if (!reached.has(target)) queue.push(target);
    }
  }
  problems.push(...unfollowedSites);

  const unreachable = modules.filter(m => !reached.has(m)).map(rel);
  return { modules: modules.length, reached: modules.filter(m => reached.has(m)).length, unreachable, problems };
}

function scanOrReport(packageDir, options) {
  // A package that cannot be scanned (e.g. an unparsable package.json) is a problem to
  // report, not a crash that hides the other packages' results.
  try {
    return scanPackage(packageDir, options);
  } catch (error) {
    return { modules: 0, reached: 0, unreachable: [], problems: [`cannot be scanned: ${error.message}`] };
  }
}

function listWorkspacePackages(repoRoot) {
  const packagesDir = path.join(repoRoot, 'packages');
  return readdirSync(packagesDir)
    .filter(name => existsSync(path.join(packagesDir, name, 'package.json')))
    .sort()
    .map(name => `packages/${name}`);
}

export function runCheck({ repoRoot = scriptRepoRoot, enforced = ENFORCED_PACKAGES, report = false, verbose = false } = {}) {
  const ts = loadTypeScript(scriptRepoRoot);
  const lines = [];
  let failed = false;
  for (const [pkg, config] of Object.entries(enforced)) {
    const packageDir = path.join(repoRoot, pkg);
    if (!existsSync(path.join(packageDir, 'package.json'))) {
      failed = true;
      lines.push(`FAIL ${pkg}: enforced package has no package.json`);
      continue;
    }
    const result = scanOrReport(packageDir, { allow: config.allow, ts });
    if (result.unreachable.length === 0 && result.problems.length === 0) {
      lines.push(`ok ${pkg}: all ${result.modules} source modules reached from declared entries or allowlisted roots`);
      continue;
    }
    failed = true;
    lines.push(`FAIL ${pkg}:`);
    for (const problem of result.problems) lines.push(`  ${problem}`);
    if (result.unreachable.length > 0) {
      lines.push(`  ${result.unreachable.length} source module(s) reached by no declared entry and not allowlisted:`);
      for (const m of result.unreachable) lines.push(`    ${m}`);
      lines.push('  Wire each one into a live path, delete it, or add it to the allowlist in');
      lines.push('  scripts/check-unreachable-modules.mjs with the reason it is started some other way.');
    }
  }
  if (report) {
    for (const pkg of listWorkspacePackages(repoRoot)) {
      if (Object.hasOwn(enforced, pkg)) continue;
      const packageDir = path.join(repoRoot, pkg);
      const result = scanOrReport(packageDir, { ts });
      const notes = result.problems.length > 0 ? `; ${result.problems.length} note(s)` : '';
      lines.push(`report ${pkg}: ${result.unreachable.length} of ${result.modules} source modules unreached${notes}`);
      if (verbose) {
        for (const problem of result.problems) lines.push(`  note: ${problem}`);
        for (const m of result.unreachable) lines.push(`    ${m}`);
      }
    }
  }
  return { failed, lines };
}

// Resolve both sides through symlinks (the module URL is already resolved unless node runs
// with --preserve-symlinks-main): otherwise a run through a symlinked path would skip the
// check and exit 0 silently.
function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === modulePath;
  }
}

if (isMainModule()) {
  const args = new Set(process.argv.slice(2));
  const { failed, lines } = runCheck({ report: args.has('--report'), verbose: args.has('--verbose') });
  for (const line of lines) (failed ? console.error : console.log)(`[unreachable-modules] ${line}`);
  process.exit(failed ? 1 : 0);
}
