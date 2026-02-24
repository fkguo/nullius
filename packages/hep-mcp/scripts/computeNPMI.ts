/**
 * NPMI Distance Matrix Computation Script
 * Run with: pnpm exec tsx scripts/computeNPMI.ts
 */

const INSPIRE_API = 'https://inspirehep.net/api/literature';
const BATCH_SIZE = 3;
const DELAY_MS = 1000;

// HEP-related categories (31 total, matching categories.ts)
const CATEGORIES = [
  // HEP Core
  'hep-th', 'hep-ph', 'hep-ex', 'hep-lat',
  // Nuclear
  'nucl-th', 'nucl-ex',
  // Gravity & Cosmology
  'gr-qc', 'astro-ph.CO', 'astro-ph.HE', 'astro-ph.GA', 'astro-ph.SR', 'astro-ph.IM',
  // Math Physics
  'math-ph', 'math.MP', 'math.QA', 'math.DG', 'math.AG',
  // Quantum
  'quant-ph',
  // Condensed Matter
  'cond-mat.str-el', 'cond-mat.supr-con', 'cond-mat.stat-mech', 'cond-mat.mes-hall', 'cond-mat.mtrl-sci',
  // CS/ML
  'cs.LG', 'cs.AI', 'cs.CV', 'stat.ML',
  // Other Physics
  'physics.ins-det', 'physics.data-an', 'physics.comp-ph', 'physics.acc-ph',
];

interface CountResult {
  category: string;
  count: number;
}

interface PairResult {
  catA: string;
  catB: string;
  count: number;
}

// Delay helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch count for a query
async function fetchCount(query: string): Promise<number> {
  const url = `${INSPIRE_API}?q=${encodeURIComponent(query)}&size=1`;
  const response = await fetch(url);
  if (!response.ok) {
    if (response.status === 429) {
      console.log('Rate limited, waiting 10s...');
      await delay(10000);
      return fetchCount(query);
    }
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.hits?.total || 0;
}

// Get single category count
async function getCategoryCount(cat: string): Promise<number> {
  return fetchCount(`arxiv_eprints.categories:${cat}`);
}

// Get pair count
async function getPairCount(catA: string, catB: string): Promise<number> {
  return fetchCount(`arxiv_eprints.categories:${catA} AND arxiv_eprints.categories:${catB}`);
}

// Calculate NPMI
function calculateNPMI(countA: number, countB: number, countAB: number, total: number): number {
  if (countAB === 0) return -1;
  if (countA === 0 || countB === 0) return 0;

  const pA = countA / total;
  const pB = countB / total;
  const pAB = countAB / total;

  const pmi = Math.log(pAB / (pA * pB));
  const npmi = pmi / (-Math.log(pAB));

  return Math.max(-1, Math.min(1, npmi));
}

// Convert NPMI to distance
function npmiToDistance(npmi: number): number {
  return (1 - npmi) / 2;
}

// Generate pair key
function pairKey(catA: string, catB: string): string {
  return catA < catB ? `${catA}|${catB}` : `${catB}|${catA}`;
}

async function main() {
  console.log('=== NPMI Distance Matrix Computation ===\n');
  console.log(`Categories: ${CATEGORIES.length}`);

  const counts: Record<string, number> = {};
  const pairCounts: Record<string, number> = {};

  // Phase 0: Get Total Papers
  console.log('\n--- Phase 0: Total Papers ---');
  // Fetch total papers that have at least one arXiv category.
  // This ensures the universe size N matches the sample space of our category counts.
  const totalPapers = await fetchCount('arxiv_eprints.categories:*');
  console.log(`Total Universe Size (N): ${totalPapers}`);

  // Phase 1: Single category counts
  console.log('\n--- Phase 1: Category Counts ---');
  for (let i = 0; i < CATEGORIES.length; i += BATCH_SIZE) {
    const batch = CATEGORIES.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(getCategoryCount));

    batch.forEach((cat, idx) => {
      counts[cat] = results[idx];
      console.log(`  ${cat}: ${results[idx]}`);
    });

    if (i + BATCH_SIZE < CATEGORIES.length) {
      await delay(DELAY_MS);
    }
  }

  // Phase 2: Pair counts
  console.log('\n--- Phase 2: Pair Counts ---');
  const pairs: [string, string][] = [];
  for (let i = 0; i < CATEGORIES.length; i++) {
    for (let j = i + 1; j < CATEGORIES.length; j++) {
      pairs.push([CATEGORIES[i], CATEGORIES[j]]);
    }
  }
  console.log(`Total pairs: ${pairs.length}`);

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(([a, b]) => getPairCount(a, b)));

    batch.forEach(([a, b], idx) => {
      pairCounts[pairKey(a, b)] = results[idx];
    });

    if ((i + BATCH_SIZE) % 30 === 0 || i + BATCH_SIZE >= pairs.length) {
      console.log(`  Progress: ${Math.min(i + BATCH_SIZE, pairs.length)}/${pairs.length}`);
    }

    if (i + BATCH_SIZE < pairs.length) {
      await delay(DELAY_MS);
    }
  }

  // Phase 3: Compute distances
  console.log('\n--- Phase 3: Computing Distances ---');
  // const totalPapers = Object.values(counts).reduce((a, b) => a + b, 0) / CATEGORIES.length; // WRONG
  const distances: Record<string, number> = {};

  pairs.forEach(([a, b]) => {
    const key = pairKey(a, b);
    const npmi = calculateNPMI(counts[a], counts[b], pairCounts[key], totalPapers);
    distances[key] = Math.round(npmiToDistance(npmi) * 100) / 100;
  });

  // Output results
  console.log('\n=== RESULTS ===\n');
  console.log('// Copy this to categories.ts SPECIFIC_DISTANCES\n');
  console.log('export const SPECIFIC_DISTANCES: Record<string, number> = {');

  const sortedKeys = Object.keys(distances).sort();
  sortedKeys.forEach(key => {
    console.log(`  '${key}': ${distances[key]},`);
  });

  console.log('};');

  // Summary statistics
  const values = Object.values(distances);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);

  console.log('\n--- Statistics ---');
  console.log(`  Average distance: ${avg.toFixed(3)}`);
  console.log(`  Min distance: ${min}`);
  console.log(`  Max distance: ${max}`);
}

main().catch(console.error);
