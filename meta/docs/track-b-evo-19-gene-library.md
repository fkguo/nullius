# EVO-19 Extension: Gene Library + Solidification — Implementation Design

> **Status**: Draft
> **Date**: 2026-02-21
> **Branch**: `redesign/track-b`
> **Ported from**: Evolver `solidify.js` (~1208 LOC), `selector.js` (~193 LOC) (MIT License, AutoGame Limited)

## 1. Overview

EVO-19 provides Track B tool evolution infrastructure: a persistent Gene Library
indexed by (trigger_signal, target_scope), Capsule → Gene generalization,
blast_radius impact measurement, and Contract Guard rule enforcement. This
builds on the EVO-20 Memory Graph as its persistence layer.

## 2. Gene Index Structure

### 2.1 Index Design

The Gene Library uses a two-level index: primary key by `(trigger_signal, target_scope)`,
with secondary indices for signal pattern matching and mutation type filtering.

```typescript
interface GeneIndex {
  /** Primary lookup: exact signal pattern + scope match */
  findExact(triggerSignal: string, targetScope: string): Promise<Gene | null>;

  /** Signal match: score all genes against current signals (ported from selector.js) */
  findBySignals(signals: string[]): Promise<ScoredGene[]>;

  /** Scope filter: all genes targeting a specific scope */
  findByScope(scope: string): Promise<Gene[]>;

  /** Mutation type filter */
  findByMutationType(type: 'repair' | 'optimize' | 'innovate'): Promise<Gene[]>;

  /** Register a new gene */
  register(gene: Gene): Promise<void>;

  /** Update gene statistics after outcome */
  updateStats(geneId: string, outcome: GeneOutcome): Promise<void>;
}
```

### 2.2 SQLite Schema (extends EVO-20 Memory Graph)

```sql
-- Gene Library (indexes into mg_nodes where node_type = 'gene')
CREATE TABLE gene_index (
  gene_id       TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL REFERENCES mg_nodes(id),
  trigger_signal TEXT NOT NULL,         -- primary trigger signal pattern
  target_scope  TEXT NOT NULL,          -- e.g., '*.ts', 'packages/shared/**'
  mutation_type TEXT NOT NULL DEFAULT 'repair',
  confidence    REAL NOT NULL DEFAULT 0.5,
  total_uses    INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  last_used     TEXT,
  created_at    TEXT NOT NULL,
  origin        TEXT NOT NULL DEFAULT 'manual'  -- manual|auto_gene|capsule_generalization
);

-- Signal pattern matching index
CREATE TABLE gene_signal_patterns (
  gene_id       TEXT NOT NULL REFERENCES gene_index(gene_id),
  signal_pattern TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (gene_id, signal_pattern)
);

CREATE INDEX idx_gene_trigger ON gene_index(trigger_signal);
CREATE INDEX idx_gene_scope ON gene_index(target_scope);
CREATE INDEX idx_gene_mutation ON gene_index(mutation_type);
CREATE INDEX idx_gene_signal_pat ON gene_signal_patterns(signal_pattern);
```

### 2.3 Gene Selection Pipeline (Ported from selector.js)

```typescript
// MIT License — ported from Evolver (AutoGame Limited)

interface ScoredGene {
  gene: Gene;
  signalScore: number;    // pattern match count
  memoryScore: number;    // from EVO-20 Memory Advice
  compositeScore: number; // weighted combination
}

function scoreGene(gene: Gene, currentSignals: string[]): number {
  // Count how many signal patterns from the gene match current signals
  let matchCount = 0;
  for (const pattern of gene.signals_match) {
    for (const signal of currentSignals) {
      if (matchesPattern(signal, pattern)) {
        matchCount++;
        break; // count each pattern once
      }
    }
  }
  return gene.signals_match.length > 0
    ? matchCount / gene.signals_match.length
    : 0;
}

function matchesPattern(signal: string, pattern: string): boolean {
  // Pattern types:
  // - exact: "error_type_mismatch" matches "error_type_mismatch"
  // - prefix: "error_*" matches "error_type_mismatch"
  // - contains: "*import*" matches "error_missing_import"
  if (pattern === signal) return true;
  if (pattern.startsWith('*') && pattern.endsWith('*')) {
    return signal.includes(pattern.slice(1, -1));
  }
  if (pattern.endsWith('*')) {
    return signal.startsWith(pattern.slice(0, -1));
  }
  if (pattern.startsWith('*')) {
    return signal.endsWith(pattern.slice(1));
  }
  return false;
}
```

### 2.4 Drift Intensity (Population Genetics Model)

Ported from `computeDriftIntensity()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
function computeDriftIntensity(effectivePopulationSize: number): number {
  // 1/sqrt(Ne) — higher drift when fewer genes available
  if (effectivePopulationSize <= 0) return 1.0;
  return 1.0 / Math.sqrt(effectivePopulationSize);
}

async function selectGene(
  signals: string[],
  store: GeneIndex,
  memoryAdvice: MemoryAdvice
): Promise<Gene | null> {
  const candidates = await store.findBySignals(signals);
  if (candidates.length === 0) return null;

  // Filter banned genes
  const filtered = candidates.filter(
    c => !memoryAdvice.bannedGeneIds.includes(c.gene.gene_id)
  );
  if (filtered.length === 0) return null;

  // Apply memory preference
  if (memoryAdvice.preferredGeneId) {
    const preferred = filtered.find(
      c => c.gene.gene_id === memoryAdvice.preferredGeneId
    );
    if (preferred) return preferred.gene;
  }

  // Stochastic selection under genetic drift
  const driftIntensity = computeDriftIntensity(filtered.length);
  if (Math.random() < driftIntensity) {
    // Random selection (exploration)
    return filtered[Math.floor(Math.random() * filtered.length)].gene;
  }

  // Deterministic selection (exploitation) — best composite score
  filtered.sort((a, b) => b.compositeScore - a.compositeScore);
  return filtered[0].gene;
}
```

### 2.5 Auto-Gene Builder

Ported from `buildAutoGene()` — creates Gene from signals when no match exists:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
function buildAutoGene(signals: string[], targetScope: string): Gene {
  return {
    gene_id: `gene_auto_${computeSignalKey(signals)}`,
    name: `Auto-repair for ${signals[0] ?? 'unknown'}`,
    signals_match: signals,
    target_scope: targetScope,
    mutation_type: 'repair',
    validation: ['npx vitest run', 'npx tsc --noEmit'],
    origin: 'auto_gene',
    epigenetic_marks: [],
    created_at: new Date().toISOString()
  };
}
```

## 3. Capsule → Gene Generalization

### 3.1 Algorithm

When a Capsule is verified successfully, it becomes a candidate for generalization
into a reusable Gene. The generalization process:

1. **Trigger extraction**: From the capsule's trigger signals, extract the
   pattern (replace specific identifiers with wildcards)
2. **Scope extraction**: From the capsule's modified files, determine the
   target scope (file extension, directory, module)
3. **Deduplication**: Check if an existing Gene already covers this pattern
4. **Confidence threshold**: Only generalize capsules with confidence ≥ 0.7
5. **Multiple capsule requirement**: Require ≥ 2 successful capsules with
   similar triggers before generalizing (prevents overfitting)

```typescript
interface GeneralizationCandidate {
  capsules: Capsule[];           // ≥2 similar successful capsules
  extractedPattern: string[];    // generalized signal patterns
  extractedScope: string;        // generalized target scope
  confidence: number;            // min confidence across capsules
}

async function attemptGeneralization(
  capsule: Capsule,
  store: GeneIndex,
  memoryGraph: MemoryGraph
): Promise<Gene | null> {
  // 1. Find similar capsules (same trigger pattern family)
  const normalizedTrigger = capsule.trigger.map(normalizeSignal);
  const similarCapsules = await memoryGraph.findSimilarCapsules(
    normalizedTrigger, JACCARD_THRESHOLD
  );

  // 2. Need ≥2 successful capsules to generalize
  const successfulSimilar = similarCapsules.filter(
    c => c.success && c.confidence >= 0.7
  );
  if (successfulSimilar.length < 2) return null;

  // 3. Check if existing gene already covers this
  const existing = await store.findExact(
    normalizedTrigger[0], extractScope(capsule.files_modified)
  );
  if (existing) {
    // Strengthen existing gene's confidence
    await store.updateStats(existing.gene_id, {
      success: true, quality: capsule.confidence
    });
    return null;
  }

  // 4. Extract generalized patterns
  const patterns = generalizePatterns(
    successfulSimilar.map(c => c.trigger)
  );
  const scope = extractScope(
    successfulSimilar.flatMap(c => c.files_modified ?? [])
  );

  // 5. Create new gene
  const gene: Gene = {
    gene_id: `gene_gen_${computeSignalKey(patterns)}`,
    name: `Generalized: ${patterns[0]}`,
    signals_match: patterns,
    target_scope: scope,
    mutation_type: 'repair',
    validation: ['npx vitest run', 'npx tsc --noEmit'],
    origin: 'capsule_generalization',
    epigenetic_marks: [],
    created_at: new Date().toISOString()
  };

  await store.register(gene);

  // 6. Record generalization edges in Memory Graph
  for (const c of successfulSimilar) {
    await memoryGraph.addEdge({
      edge_type: 'generalizes',
      source_id: c.node_id,
      target_id: gene.node_id,
      payload: {}
    });
  }

  return gene;
}

function generalizePatterns(triggerSets: string[][]): string[] {
  // Find common signal prefixes across all trigger sets
  // Replace varying suffixes with wildcards
  const allSignals = triggerSets.flat().map(normalizeSignal);
  const freq = new Map<string, number>();
  for (const sig of allSignals) {
    freq.set(sig, (freq.get(sig) ?? 0) + 1);
  }

  // Keep signals that appear in ≥50% of trigger sets
  const threshold = triggerSets.length * 0.5;
  return [...freq.entries()]
    .filter(([_, count]) => count >= threshold)
    .map(([sig, _]) => sig);
}

function extractScope(files: string[]): string {
  if (files.length === 0) return '*';
  // Find common directory prefix
  const parts = files.map(f => f.split('/'));
  let commonDepth = 0;
  outer: for (let i = 0; i < parts[0].length - 1; i++) {
    const segment = parts[0][i];
    for (const p of parts) {
      if (p[i] !== segment) break outer;
    }
    commonDepth = i + 1;
  }
  const commonPrefix = parts[0].slice(0, commonDepth).join('/');

  // Find common extension
  const exts = new Set(files.map(f => f.split('.').pop()));
  const extPattern = exts.size === 1 ? `*.${[...exts][0]}` : '*';

  return commonPrefix ? `${commonPrefix}/**/${extPattern}` : extPattern;
}
```

## 4. Blast Radius Calculation

### 4.1 Core Algorithm (Ported from solidify.js)

```typescript
// MIT License — ported from Evolver (AutoGame Limited)

/** Snapshot of repo state before mutation, used to scope blast radius to delta only. */
interface BaselineSnapshot {
  /** Tracked files that were already dirty (modified/staged) before mutation */
  trackedDirtyFiles: string[];
  /** Untracked files that existed before mutation */
  untrackedFiles: string[];
}

/** Call before mutation to capture pre-existing dirty state.
 *  Uses both staged (--cached) and unstaged diffs to catch all dirty files. */
async function captureBaseline(repoRoot: string): Promise<BaselineSnapshot> {
  // Staged changes (index vs HEAD)
  const stagedRaw = await execGit(
    repoRoot,
    ['diff', '--name-only', '--cached', 'HEAD']
  );
  // Unstaged changes (worktree vs HEAD)
  const unstagedRaw = await execGit(
    repoRoot,
    ['diff', '--name-only', 'HEAD']
  );
  // Union of both — a file may be staged-only, unstaged-only, or both
  const allDirty = [...new Set([
    ...stagedRaw.split('\n').filter(Boolean),
    ...unstagedRaw.split('\n').filter(Boolean)
  ])];
  const untrackedRaw = await execGit(
    repoRoot,
    ['ls-files', '--others', '--exclude-standard']
  );
  return {
    trackedDirtyFiles: allDirty,
    untrackedFiles: untrackedRaw.split('\n').filter(Boolean)
  };
}

interface BlastRadius {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  files_list: string[];
  untracked_files: string[];
  constraint_violations: string[];
}

async function computeBlastRadius(
  repoRoot: string,
  baseline: BaselineSnapshot,
  constraintPolicy?: ConstraintPolicy
): Promise<BlastRadius> {
  // 1. Get staged + unstaged changes via git diff
  const diffStat = await execGit(
    repoRoot,
    ['diff', '--stat', '--numstat', 'HEAD']
  );

  // 2. Get untracked files
  const untrackedRaw = await execGit(
    repoRoot,
    ['ls-files', '--others', '--exclude-standard']
  );
  const untrackedFilesNow = untrackedRaw.split('\n').filter(Boolean);

  // 3. Scope to mutation delta only — exclude pre-existing dirty state
  const untrackedFiles = untrackedFilesNow.filter(
    f => !baseline.untrackedFiles.includes(f)
  );

  // 4. Parse numstat output
  let linesAdded = 0;
  let linesRemoved = 0;
  const filesChanged: string[] = [];
  const constraintViolations: string[] = [];

  for (const line of diffStat.split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    const added = match[1] === '-' ? 0 : parseInt(match[1]);
    const removed = match[2] === '-' ? 0 : parseInt(match[2]);
    const file = match[3];

    // 5. Skip files that were already dirty before mutation
    if (baseline.trackedDirtyFiles.includes(file)) continue;

    // 6. Detect constraint policy violations (never filter — always report full delta)
    if (constraintPolicy && !passesFilter(file, constraintPolicy)) {
      constraintViolations.push(file);
      // DO NOT skip — include in blast radius so rollback sees full delta
    }

    linesAdded += added;
    linesRemoved += removed;
    filesChanged.push(file);
  }

  return {
    files_changed: filesChanged.length + untrackedFiles.length,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    files_list: filesChanged,
    untracked_files: untrackedFiles,
    constraint_violations: constraintViolations
  };
}
```

### 4.2 Blast Severity Classification

Ported from `classifyBlastSeverity()`:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const BLAST_RADIUS_HARD_CAP_FILES = 60;
const BLAST_RADIUS_HARD_CAP_LINES = 20000;

type BlastSeverity =
  | 'within_limit'
  | 'approaching_limit'
  | 'exceeded'
  | 'critical_overrun'
  | 'hard_cap_breach';

function classifyBlastSeverity(
  br: BlastRadius,
  gene: Gene
): BlastSeverity {
  const maxFiles = gene.max_files ?? 10;
  const totalLines = br.lines_added + br.lines_removed;

  // Hard cap breach — always reject
  if (br.files_changed > BLAST_RADIUS_HARD_CAP_FILES ||
      totalLines > BLAST_RADIUS_HARD_CAP_LINES) {
    return 'hard_cap_breach';
  }

  // Critical overrun (>3x limit)
  if (br.files_changed > maxFiles * 3) {
    return 'critical_overrun';
  }

  // Exceeded (>1x limit)
  if (br.files_changed > maxFiles) {
    return 'exceeded';
  }

  // Approaching limit (>0.7x limit)
  if (br.files_changed > maxFiles * 0.7) {
    return 'approaching_limit';
  }

  return 'within_limit';
}
```

### 4.3 CI Integration

Blast radius integrates into CI as a risk signal:

```typescript
interface BlastRadiusCIReport {
  severity: BlastSeverity;
  files_changed: number;
  lines_churned: number;
  risk_modules: string[];     // modules with high failure frequency (from EVO-20)
  suggested_gate: GateLevel;  // A0 (auto) | A1 | A2 (human review)
  contract_violations: ContractViolation[];  // from Contract Guard
}
```

## 5. Contract Guard

### 5.1 Rule Mapping

The Contract Guard ensures evolution outputs comply with ECOSYSTEM_DEV_CONTRACT.md.
Each rule is mapped to a programmatic check:

| Contract Rule | Guard Check | Fail Behavior |
|---|---|---|
| CODE-01.1 | `checkFileLOC(file) ≤ 200` for all modified files | fail-closed |
| CODE-01.2 | `!matchesBannedName(file)` for utils/helpers/common/service/misc | fail-closed |
| CODE-01.3 | `!hasBusinessLogicInIndex(file)` for index.ts/__init__.py | fail-closed |
| CODE-01.4 | `!containsTypeEscape(file)` for `as any`, `@ts-ignore`, etc. | fail-closed |
| CODE-01.5 | `!hasEmptyCatch(file)` for empty catch blocks | fail-closed |
| ERR-01 | `usesErrorFactory(file)` for throw/raise statements | fail-closed |
| SEC-01 | `withinPathWhitelist(file)` for output paths | fail-closed |
| SEC-03 | `hasRiskLevel(toolSpec)` for new MCP tool definitions | fail-closed |
| GATE-01 | `gateRegistered(gateId)` for any gate references | fail-closed |

### 5.2 Guard Implementation

```typescript
interface ContractViolation {
  rule_id: string;         // e.g., "CODE-01.1"
  file: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning';
  auto_fixable: boolean;
}

interface ContractGuardResult {
  passed: boolean;
  violations: ContractViolation[];
  checked_rules: string[];
}

async function checkContract(
  blastRadius: BlastRadius,
  repoRoot: string
): Promise<ContractGuardResult> {
  const violations: ContractViolation[] = [];
  const allFiles = [...blastRadius.files_list, ...blastRadius.untracked_files];

  for (const file of allFiles) {
    const fullPath = path.join(repoRoot, file);
    if (!existsSync(fullPath)) continue;

    const content = readFileSync(fullPath, 'utf-8');
    const ext = path.extname(file);

    // CODE-01.1: ≤200 eLOC
    if (ext === '.ts' || ext === '.py') {
      const eloc = countEffectiveLOC(content, ext);
      if (eloc > 200) {
        violations.push({
          rule_id: 'CODE-01.1',
          file,
          message: `File has ${eloc} eLOC (limit: 200)`,
          severity: 'error',
          auto_fixable: false
        });
      }
    }

    // CODE-01.2: Banned file names
    const basename = path.basename(file, ext);
    const bannedNames = ['utils', 'helpers', 'common', 'service', 'misc'];
    if (bannedNames.includes(basename)) {
      violations.push({
        rule_id: 'CODE-01.2',
        file,
        message: `Banned filename "${basename}" — use domain-specific name`,
        severity: 'error',
        auto_fixable: false
      });
    }

    // CODE-01.3: Index files must only contain re-exports (no business logic)
    if (basename === 'index' && (ext === '.ts' || ext === '.py')) {
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
        // TypeScript: allow only export/re-export statements
        if (ext === '.ts') {
          // Allow ONLY re-export forms: export * from, export { } from, export type { } from
          if (/^export\s+(type\s+)?\{[^}]*\}\s+from\s/.test(trimmed)) continue;
          if (/^export\s+\*\s+(as\s+\w+\s+)?from\s/.test(trimmed)) continue;
          if (/^export\s+type\s+\*\s+from\s/.test(trimmed)) continue;
          if (/^import\s+type\s/.test(trimmed)) continue;
          if (/^import\s+\{[^}]*\}\s+from\s/.test(trimmed)) continue;
          if (/^import\s+\*\s+as\s+\w+\s+from\s/.test(trimmed)) continue;
          // Bare side-effect imports (import './foo') = business logic
        }
        // Python: allow only import/from...import and __all__ assignments
        if (ext === '.py') {
          if (/^(from\s|import\s|__all__\s*=)/.test(trimmed)) continue;
        }
        // Any other statement is business logic in an index file
        violations.push({
          rule_id: 'CODE-01.3',
          file,
          line: i + 1,
          message: `Index file contains business logic at line ${i + 1}: "${trimmed.slice(0, 60)}"`,
          severity: 'error',
          auto_fixable: false
        });
        break; // report first violation only
      }
    }

    // CODE-01.4: Type safety escapes
    if (ext === '.ts') {
      const escapePatterns = [/\bas\s+any\b/g, /@ts-ignore/g, /@ts-expect-error/g];
      for (const pat of escapePatterns) {
        const matches = content.match(pat);
        if (matches) {
          violations.push({
            rule_id: 'CODE-01.4',
            file,
            message: `Type escape "${matches[0]}" found (${matches.length} occurrences)`,
            severity: 'error',
            auto_fixable: false
          });
        }
      }
    }

    // CODE-01.5: Empty catch blocks
    if (content.match(/catch\s*\([^)]*\)\s*\{\s*\}/)) {
      violations.push({
        rule_id: 'CODE-01.5',
        file,
        message: 'Empty catch block found',
        severity: 'error',
        auto_fixable: false
      });
    }

    // ERR-01: Raw throws — flag each raw throw individually
    if (ext === '.ts') {
      const throwPattern = /throw\s+new\s+Error\s*\(/g;
      const factoryPattern = /throw\s+new\s+(AutoresearchError|McpError|RpcError)\s*\(/;
      if (throwPattern.test(content) && !factoryPattern.test(content)) {
        // File has raw throws but no factory throws — definitely a violation
        violations.push({
          rule_id: 'ERR-01',
          file,
          message: 'Raw `throw new Error()` — use AutoresearchError/McpError/RpcError factory',
          severity: 'error',
          auto_fixable: true
        });
      } else if (content.match(/throw\s+new\s+Error\s*\(/)) {
        // File has BOTH raw throws and factory throws — still a violation
        // (factory usage elsewhere doesn't excuse raw throws)
        violations.push({
          rule_id: 'ERR-01',
          file,
          message: 'Raw `throw new Error()` found alongside factory throws — replace all raw throws',
          severity: 'error',
          auto_fixable: true
        });
      }
    }
  }

  // SEC-01: Path whitelist check
  for (const file of allFiles) {
    if (!isWithinAllowedPaths(file)) {
      violations.push({
        rule_id: 'SEC-01',
        file,
        message: `File outside allowed paths (repo_root/ or configured DATA_DIR)`,
        severity: 'error',
        auto_fixable: false
      });
    }
  }

  // SEC-03: New MCP tool definitions must have a risk_level field
  for (const file of allFiles) {
    const fullPath = path.join(repoRoot, file);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, 'utf-8');
    const ext = path.extname(file);

    const isToolFile = file.match(/tool.*\.ts$/) || content.includes('server.tool(');
    if (ext === '.ts' && isToolFile) {
      if (!content.includes('risk_level')) {
        violations.push({
          rule_id: 'SEC-03',
          file,
          message: 'MCP tool definition missing required risk_level field',
          severity: 'error',
          auto_fixable: false
        });
      }
    }
  }

  // GATE-01: Gate references must correspond to registered gates
  for (const file of allFiles) {
    const fullPath = path.join(repoRoot, file);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, 'utf-8');

    const gateRefPattern = /(?:gate:\s*['"]([^'"]+)['"]|GateSpec\(['"]([^'"]+)['"]\))/g;
    let gateMatch;
    while ((gateMatch = gateRefPattern.exec(content)) !== null) {
      const gateId = gateMatch[1] ?? gateMatch[2];
      if (!registeredGates.has(gateId)) {
        violations.push({
          rule_id: 'GATE-01',
          file,
          message: `Gate reference "${gateId}" does not match any registered gate`,
          severity: 'error',
          auto_fixable: false
        });
      }
    }
  }

  return {
    passed: violations.filter(v => v.severity === 'error').length === 0,
    violations,
    checked_rules: [
      'CODE-01.1', 'CODE-01.2', 'CODE-01.3', 'CODE-01.4', 'CODE-01.5',
      'ERR-01', 'SEC-01', 'SEC-03', 'GATE-01'
    ]
  };
}

function countEffectiveLOC(content: string, ext: string): number {
  const lines = content.split('\n');
  let eloc = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // Block comment tracking
    if (ext === '.ts') {
      if (trimmed.startsWith('/*')) inBlockComment = true;
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith('//')) continue;
    } else if (ext === '.py') {
      // Multiline docstring tracking (""" and ''')
      if (!inBlockComment && (trimmed.startsWith('"""') || trimmed.startsWith("'''"))) {
        const delimiter = trimmed.slice(0, 3);
        // Check if docstring opens and closes on the same line
        if (trimmed.length > 3 && trimmed.endsWith(delimiter) && trimmed !== delimiter) {
          continue; // single-line docstring
        }
        inBlockComment = true;
        continue;
      }
      if (inBlockComment) {
        if (trimmed.endsWith('"""') || trimmed.endsWith("'''")) inBlockComment = false;
        continue;
      }
      // Single-line comments
      if (trimmed.startsWith('#')) continue;
    }

    eloc++;
  }
  return eloc;
}
```

### 5.3 Constraint Policy

Ported from solidify.js constraint checking:

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
interface ConstraintPolicy {
  max_files: number;
  include_prefixes: string[];    // only count files matching these prefixes
  exclude_prefixes: string[];    // exclude files matching these prefixes
  include_extensions: string[];  // only count files with these extensions
  forbidden_paths: string[];     // paths that must not be modified
  critical_paths: string[];      // paths requiring elevated review
}

const DEFAULT_CONSTRAINT_POLICY: ConstraintPolicy = {
  max_files: 10,
  include_prefixes: ['packages/', 'src/'],
  exclude_prefixes: ['node_modules/', '.git/', 'dist/'],
  include_extensions: ['.ts', '.js', '.py', '.json'],
  forbidden_paths: [
    'ECOSYSTEM_DEV_CONTRACT.md',
    'package-lock.json',
    '.github/workflows/'
  ],
  critical_paths: [
    'packages/shared/',
    'autoresearch-meta/schemas/'
  ]
};

function checkConstraints(
  br: BlastRadius,
  policy: ConstraintPolicy
): ContractViolation[] {
  const violations: ContractViolation[] = [];

  // Max files check
  if (br.files_changed > policy.max_files) {
    violations.push({
      rule_id: 'CONSTRAINT-MAX-FILES',
      file: '*',
      message: `${br.files_changed} files changed (limit: ${policy.max_files})`,
      severity: 'warning',
      auto_fixable: false
    });
  }

  // Forbidden paths check
  for (const file of br.files_list) {
    for (const forbidden of policy.forbidden_paths) {
      if (file.startsWith(forbidden) || file === forbidden) {
        violations.push({
          rule_id: 'CONSTRAINT-FORBIDDEN',
          file,
          message: `Modification of forbidden path: ${forbidden}`,
          severity: 'error',
          auto_fixable: false
        });
      }
    }
  }

  return violations;
}
```

## 6. Validation Pipeline

### 6.1 Validation Commands (Ported from solidify.js)

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const ALLOWED_COMMANDS = ['node', 'npm', 'npx'];

async function runValidations(
  gene: Gene,
  repoRoot: string
): Promise<ValidationResult> {
  const results: ValidationStepResult[] = [];

  for (const cmd of gene.validation) {
    // Safety: only allow whitelisted command prefixes
    const binary = cmd.split(/\s+/)[0];
    if (!ALLOWED_COMMANDS.includes(binary)) {
      results.push({
        command: cmd,
        passed: false,
        error: `Command "${binary}" not in allowlist: ${ALLOWED_COMMANDS.join(', ')}`
      });
      continue;
    }

    // Safety: no shell operators (including redirection)
    if (/[|;&`$<>]/.test(cmd)) {
      results.push({
        command: cmd,
        passed: false,
        error: 'Shell operators not allowed in validation commands (including redirection)'
      });
      continue;
    }

    try {
      const { exitCode, stdout, stderr } = await execCommand(cmd, {
        cwd: repoRoot,
        timeout: 120_000  // 2 minute timeout
      });
      results.push({
        command: cmd,
        passed: exitCode === 0,
        stdout: stdout.slice(0, 2000),
        stderr: stderr.slice(0, 2000)
      });
    } catch (err) {
      results.push({
        command: cmd,
        passed: false,
        error: String(err)
      });
    }
  }

  return {
    all_passed: results.every(r => r.passed),
    steps: results
  };
}
```

### 6.2 Canary Check

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
async function runCanaryCheck(repoRoot: string): Promise<boolean> {
  // Verify the main entry point still loads
  const entryPoint = path.join(repoRoot, 'packages/shared/src/index.ts');
  if (!existsSync(entryPoint)) return true; // no entry point to check

  try {
    await execCommand('npx tsc --noEmit', {
      cwd: repoRoot,
      timeout: 60_000
    });
    return true;
  } catch {
    return false;
  }
}
```

## 7. Solidification Pipeline

### 7.1 Full Pipeline (Ported from solidify.js)

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
async function solidify(
  gene: Gene,
  signals: string[],
  repoRoot: string,
  memoryGraph: MemoryGraph,
  geneIndex: GeneIndex,
  contractGuard: ContractGuard
): Promise<SolidifyResult> {
  const runId = generateRunId();

  // 0. Precondition: require FULLY clean worktree (tracked + untracked) for
  //    safe rollback isolation. Untracked files are equally dangerous: a
  //    mutation that edits a pre-existing untracked file won't appear in
  //    `git diff`, won't be counted in blast radius delta, and won't be
  //    rolled back — silently bypassing both Contract Guard and rollback.
  const baseline = await captureBaseline(repoRoot);
  if (baseline.trackedDirtyFiles.length > 0 || baseline.untrackedFiles.length > 0) {
    const dirtyCount = baseline.trackedDirtyFiles.length;
    const untrackedCount = baseline.untrackedFiles.length;
    const samples = [
      ...baseline.trackedDirtyFiles.slice(0, 3),
      ...baseline.untrackedFiles.slice(0, 3)
    ];
    throw new AutoresearchError(
      'DIRTY_WORKTREE',
      `Worktree must be fully clean — ${dirtyCount} dirty tracked, ` +
      `${untrackedCount} untracked files. Commit, stash, or .gitignore ` +
      `before running evolution. Files: ${samples.join(', ')}` +
      `${dirtyCount + untrackedCount > 6 ? '...' : ''}`
    );
  }

  // 1. Record attempt
  await memoryGraph.recordAttempt(runId, gene.gene_id);

  // 2. Compute blast radius (scoped to mutation delta only)
  const blastRadius = await computeBlastRadius(repoRoot, baseline, gene.constraint_policy);
  const severity = classifyBlastSeverity(blastRadius, gene);

  // 3. Hard cap check — reject immediately
  if (severity === 'hard_cap_breach') {
    await rollback(repoRoot, blastRadius, baseline);
    await memoryGraph.recordOutcome(runId, gene.gene_id, {
      success: false,
      reason: 'hard_cap_breach',
      signal_key: computeSignalKey(signals)
    });
    return { success: false, reason: 'hard_cap_breach', severity };
  }

  // 3b. Risk-matrix reject check — fail-closed for any gate=reject
  //     e.g. innovate + critical_overrun resolves to 'reject' in RISK_GATE_MATRIX.
  //     This must be checked before validations to prevent wasted work.
  const earlyGate = determineGateLevel(gene.mutation_type ?? 'repair', severity, 0);
  if (earlyGate === 'reject') {
    await rollback(repoRoot, blastRadius, baseline);
    await memoryGraph.recordOutcome(runId, gene.gene_id, {
      success: false,
      reason: 'risk_reject',
      signal_key: computeSignalKey(signals),
      details_artifact_uri: await storeArtifact('outcome_detail', {
        gate: 'reject',
        mutation_type: gene.mutation_type ?? 'repair',
        severity
      })
    });
    return { success: false, reason: 'risk_reject', severity };
  }

  // 4. Contract Guard check
  const guardResult = await contractGuard.check(blastRadius, repoRoot);
  if (!guardResult.passed) {
    await rollback(repoRoot, blastRadius, baseline);
    await memoryGraph.recordOutcome(runId, gene.gene_id, {
      success: false,
      reason: 'contract_violation',
      signal_key: computeSignalKey(signals),
      // Store violations detail via H-18 artifact, not in the event payload
      details_artifact_uri: await storeArtifact('outcome_detail', { violations: guardResult.violations })
    });
    return { success: false, reason: 'contract_violation', guardResult, severity };
  }

  // 5. Run validations
  const validation = await runValidations(gene, repoRoot);
  if (!validation.all_passed) {
    await rollback(repoRoot, blastRadius, baseline);
    await memoryGraph.recordOutcome(runId, gene.gene_id, {
      success: false,
      reason: 'validation_failed',
      signal_key: computeSignalKey(signals),
      // Store validation detail via H-18 artifact, not in the event payload
      details_artifact_uri: await storeArtifact('outcome_detail', { validation })
    });
    return { success: false, reason: 'validation_failed', validation, severity };
  }

  // 6. Canary check
  const canaryPassed = await runCanaryCheck(repoRoot);
  if (!canaryPassed) {
    await rollback(repoRoot, blastRadius, baseline);
    await memoryGraph.recordOutcome(runId, gene.gene_id, {
      success: false,
      reason: 'canary_failed',
      signal_key: computeSignalKey(signals)
    });
    return { success: false, reason: 'canary_failed', severity };
  }

  // 7. Success — create capsule
  const capsule = createCapsule(gene, signals, blastRadius);

  // 8. Record success in Memory Graph
  await memoryGraph.recordOutcome(runId, gene.gene_id, {
    success: true,
    blast_radius: {
      files_changed: blastRadius.files_changed,
      lines_added: blastRadius.lines_added,
      lines_removed: blastRadius.lines_removed,
      severity
    },
    files_modified: blastRadius.files_list,
    signal_key: computeSignalKey(signals)
  });
  await memoryGraph.recordConfidenceEdge(
    computeSignalKey(signals), gene.gene_id, true
  );

  // 9. Apply epigenetic marks
  await applyEpigeneticMarks(gene, true, memoryGraph);

  // 10. Attempt capsule → gene generalization (EVO-19 extension)
  await attemptGeneralization(capsule, geneIndex, memoryGraph);

  // 11. Determine gate level (canonical source: EVO-21 RISK_GATE_MATRIX)
  const gateLevel = determineGateLevel(
    gene.mutation_type ?? 'repair', severity, countRiskModules(blastRadius, memoryGraph)
  );

  return {
    success: true,
    capsule,
    severity,
    gateLevel,
    validation,
    guardResult
  };
}

async function rollback(
  repoRoot: string,
  blastRadius: BlastRadius,
  baseline: BaselineSnapshot
): Promise<void> {
  // Safety design: We only rollback files that were actually changed by the
  // current mutation attempt, NOT the entire working tree. This prevents
  // destroying unrelated dirty work that existed before the mutation.
  //
  // 1. Compute delta: files changed by mutation = (current state) - (baseline)
  // 2. Restore only those tracked files via `git restore <file>`
  // 3. Remove only those untracked files that didn't exist in baseline

  // Restore only tracked files that were part of this mutation's delta
  const trackedDelta = blastRadius.files_list.filter(
    f => !baseline.trackedDirtyFiles.includes(f)
  );
  if (trackedDelta.length > 0) {
    // Restore both worktree AND index to HEAD state.
    // --source=HEAD reverts to committed version.
    // --staged --worktree clears both staging area and working tree.
    await execGit(repoRoot, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...trackedDelta]);
  }

  // Remove only untracked files created by this mutation
  const untrackedDelta = blastRadius.untracked_files.filter(
    f => !baseline.untrackedFiles.includes(f)
  );
  for (const file of untrackedDelta) {
    const fullPath = path.join(repoRoot, file);
    if (existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
}
```

### 7.2 Epigenetic Marks

```typescript
// MIT License — ported from Evolver (AutoGame Limited)
const EPIGENETIC_SUCCESS_BOOST = 0.05;
const EPIGENETIC_FAILURE_PENALTY = -0.1;
const EPIGENETIC_TTL_DAYS = 90;
const MAX_EPIGENETIC_MARKS = 10;

async function applyEpigeneticMarks(
  gene: Gene,
  success: boolean,
  store: MemoryGraph
): Promise<void> {
  const envKey = detectEnvironment(); // platform, arch, node_version
  const modifier = success ? EPIGENETIC_SUCCESS_BOOST : EPIGENETIC_FAILURE_PENALTY;

  const mark: EpigeneticMark = {
    env_key: envKey,
    modifier,
    ttl_days: EPIGENETIC_TTL_DAYS,
    created_at: new Date().toISOString()
  };

  // Add mark, pruning expired and keeping max 10
  const existing = gene.epigenetic_marks ?? [];
  const now = new Date();
  const active = existing.filter(m => {
    const age = (now.getTime() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24);
    return age < m.ttl_days;
  });

  active.push(mark);
  if (active.length > MAX_EPIGENETIC_MARKS) {
    active.splice(0, active.length - MAX_EPIGENETIC_MARKS);
  }

  gene.epigenetic_marks = active;
  await store.updateGeneMarks(gene.gene_id, active);
}
```

## 8. File Layout (CODE-01 Compliant)

```
packages/evolver-bridge/src/
├── index.ts                    -- re-exports only
├── gene-library/
│   ├── index.ts                -- re-exports
│   ├── types.ts                -- Gene, Capsule, ConstraintPolicy types (~60 eLOC)
│   ├── gene-index.ts           -- GeneIndex interface + SQLite impl (~150 eLOC)
│   ├── gene-selector.ts        -- scoreGene, selectGene, driftIntensity (~120 eLOC)
│   ├── auto-gene.ts            -- buildAutoGene (~40 eLOC)
│   └── generalization.ts       -- Capsule → Gene generalization (~140 eLOC)
├── solidify/
│   ├── index.ts                -- re-exports
│   ├── blast-radius.ts         -- computeBlastRadius, classifyBlastSeverity (~100 eLOC)
│   ├── constraints.ts          -- ConstraintPolicy, checkConstraints (~80 eLOC)
│   ├── validation.ts           -- runValidations, runCanaryCheck (~90 eLOC)
│   ├── solidify-pipeline.ts    -- solidify() orchestrator (~120 eLOC)
│   ├── rollback.ts             -- rollback, epigenetic marks (~70 eLOC)
│   └── ci-report.ts            -- BlastRadiusCIReport (~40 eLOC)
├── gate-guard/
│   ├── index.ts                -- re-exports
│   ├── contract-guard.ts       -- checkContract orchestrator (~100 eLOC)
│   ├── code01-checks.ts        -- CODE-01 rule checks (~120 eLOC)
│   ├── err-checks.ts           -- ERR-01 checks (~50 eLOC)
│   └── sec-checks.ts           -- SEC-01, SEC-03 checks (~60 eLOC)
└── config.ts                   -- Evolver bridge configuration (~50 eLOC)
```

**Estimated total**: ~1,410 eLOC across 17 implementation files.

## 9. JSON Schema Definitions

See companion schema files:
- `schemas/gene_v1.schema.json`
- `schemas/capsule_v1.schema.json`

## 10. Dependencies

| Prerequisite | Status | Notes |
|---|---|---|
| EVO-20 (Memory Graph) | This design | Gene Library stores into Memory Graph |
| NEW-05 (Monorepo) | Phase 0, pending | `packages/evolver-bridge/` package |
| EVO-04 (Agent Registry) | Phase 5, pending | Gene Library publishable to registry |
| M-06 (SQLite WAL) | Phase 2, pending | Shared with Memory Graph |

## 11. MIT Attribution Notice

```
Portions of this module are derived from Evolver (https://github.com/autogame-17/evolver)
Copyright (c) 2024-2026 AutoGame Limited
Licensed under the MIT License

Specifically ported algorithms:
- Gene selection scoring pipeline (selector.js)
- Drift intensity calculation (selector.js)
- Blast radius computation (solidify.js)
- Blast severity classification (solidify.js)
- Constraint checking (solidify.js)
- Validation pipeline with command allowlist (solidify.js)
- Canary check (solidify.js)
- Epigenetic marks (solidify.js)
- Auto-gene builder (solidify.js)
- Solidification pipeline (solidify.js)
```
