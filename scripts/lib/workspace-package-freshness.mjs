import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function collectArtifactPaths(pkgJson) {
  const artifacts = new Set();

  const addMaybe = value => {
    if (typeof value === 'string' && value.trim() !== '') {
      artifacts.add(value);
    }
  };

  addMaybe(pkgJson.main);
  addMaybe(pkgJson.module);
  addMaybe(pkgJson.types);

  if (pkgJson.bin && typeof pkgJson.bin === 'object') {
    for (const value of Object.values(pkgJson.bin)) {
      addMaybe(value);
    }
  }

  if (pkgJson.exports && typeof pkgJson.exports === 'object') {
    const stack = [pkgJson.exports];
    while (stack.length > 0) {
      const node = stack.pop();
      if (typeof node === 'string') {
        addMaybe(node);
        continue;
      }
      if (node && typeof node === 'object') {
        for (const value of Object.values(node)) {
          stack.push(value);
        }
      }
    }
  }

  return [...artifacts];
}

function normalizeArtifactPath(relPath) {
  return relPath.replace(/^[.][/\\]/, '');
}

function inferDistDirName(pkgJson) {
  const relativePaths = collectArtifactPaths(pkgJson)
    .map(normalizeArtifactPath)
    .filter(relPath => relPath !== '');
  if (relativePaths.length === 0) {
    return null;
  }

  const roots = new Set(
    relativePaths.map(relPath => relPath.split(/[\\/]/)[0]).filter(Boolean)
  );
  if (roots.size !== 1) {
    return null;
  }
  return [...roots][0];
}

export function resolvePackageFreshnessRoots(packageDir, pkgJson) {
  const srcRoot = path.join(packageDir, 'src');
  const distDirName = inferDistDirName(pkgJson);
  if (distDirName === null) {
    return null;
  }
  return {
    srcRoot,
    distRoot: path.join(packageDir, distDirName),
  };
}

export function resolvePackageFreshnessOptions({ packageDir, packageLabel }) {
  const resolvedPackageDir = path.resolve(packageDir);
  const packageJsonPath = path.join(resolvedPackageDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found under ${resolvedPackageDir}`);
  }
  const pkgJson = readJson(packageJsonPath);
  const roots = resolvePackageFreshnessRoots(resolvedPackageDir, pkgJson);
  if (roots === null) {
    throw new Error(
      `Unable to infer a shared dist root from package artifacts under ${resolvedPackageDir}`
    );
  }

  return {
    packageDir: resolvedPackageDir,
    packageLabel: packageLabel ?? pkgJson.name ?? path.basename(resolvedPackageDir),
    srcRoot: roots.srcRoot,
    distRoot: roots.distRoot,
  };
}

export function collectSourceFiles(dirPath) {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (
      !fullPath.endsWith('.ts') ||
      fullPath.endsWith('.d.ts') ||
      fullPath.endsWith('.test.ts')
    ) {
      continue;
    }
    out.push(fullPath);
  }
  return out.sort((left, right) => left.localeCompare(right));
}

export function buildArtifactPaths(sourcePath, srcRoot, distRoot) {
  const relative = path.relative(srcRoot, sourcePath);
  const stem = relative.slice(0, -'.ts'.length);
  return {
    primaryPath: path.join(distRoot, `${stem}.js`),
    declarationPath: path.join(distRoot, `${stem}.d.ts`),
  };
}

export function toDisplayPath(repoRoot, targetPath) {
  const relative = path.relative(repoRoot, targetPath);
  if (!relative.startsWith('..') && relative !== '') {
    return relative;
  }
  return targetPath;
}

export function collectFreshnessErrors({ repoRoot, srcRoot, distRoot }) {
  if (!existsSync(srcRoot)) {
    return [`Source root not found: ${toDisplayPath(repoRoot, srcRoot)}`];
  }
  if (!existsSync(distRoot)) {
    return [`Dist root not found: ${toDisplayPath(repoRoot, distRoot)}`];
  }

  const sourceFiles = collectSourceFiles(srcRoot);
  if (sourceFiles.length === 0) {
    return [`No source files found under ${toDisplayPath(repoRoot, srcRoot)}`];
  }

  const errors = [];
  for (const sourcePath of sourceFiles) {
    const sourceStat = statSync(sourcePath);
    const { primaryPath, declarationPath } = buildArtifactPaths(sourcePath, srcRoot, distRoot);
    if (!existsSync(primaryPath)) {
      errors.push(
        `missing emitted artifact: source=${toDisplayPath(repoRoot, sourcePath)} artifact=${toDisplayPath(repoRoot, primaryPath)}`
      );
      continue;
    }
    if (!existsSync(declarationPath)) {
      errors.push(
        `missing emitted artifact: source=${toDisplayPath(repoRoot, sourcePath)} artifact=${toDisplayPath(repoRoot, declarationPath)}`
      );
      continue;
    }

    const artifactStat = statSync(primaryPath);
    if (artifactStat.mtimeMs < sourceStat.mtimeMs) {
      errors.push(
        `stale emitted artifact: source=${toDisplayPath(repoRoot, sourcePath)} artifact=${toDisplayPath(repoRoot, primaryPath)}`
      );
    }
  }

  return errors;
}
