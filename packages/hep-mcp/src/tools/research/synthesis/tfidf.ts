/**
 * TF-IDF (Term Frequency-Inverse Document Frequency) Calculation
 * Used for semantic similarity and document clustering
 */

// Stop words to exclude from TF-IDF
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our', 'they', 'their',
  'which', 'where', 'when', 'what', 'who', 'how', 'than', 'then', 'can', 'also',
  'into', 'over', 'such', 'no', 'not', 'only', 'same', 'so', 'here', 'there',
  'each', 'all', 'both', 'most', 'other', 'some', 'any', 'one', 'two', 'new',
]);

/**
 * Tokenize text into words
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * Calculate TF (Term Frequency) for a document
 */
export function calculateTF(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  // Normalize by document length
  for (const [term, count] of tf) {
    tf.set(term, count / tokens.length);
  }
  return tf;
}

/**
 * Calculate IDF (Inverse Document Frequency) for a corpus
 */
export function calculateIDF(documents: string[][]): Map<string, number> {
  const docCount = documents.length;
  const termDocCounts = new Map<string, number>();

  for (const doc of documents) {
    const uniqueTerms = new Set(doc);
    for (const term of uniqueTerms) {
      termDocCounts.set(term, (termDocCounts.get(term) || 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, count] of termDocCounts) {
    // Classic IDF formula: log(N / df)
    idf.set(term, Math.log(docCount / count));
  }
  return idf;
}

/**
 * Calculate TF-IDF scores for all documents
 * @param documents - Array of tokenized documents
 * @param documentIds - Optional array of document IDs (same length as documents)
 * @returns Map from document ID (or index) to TF-IDF scores
 */
export function calculateTFIDF(
  documents: string[][],
  documentIds?: string[]
): Map<string, Map<string, number>> {
  // Calculate IDF
  const idf = calculateIDF(documents);

  // Calculate TF-IDF for each document
  const tfidfScores = new Map<string, Map<string, number>>();

  for (let i = 0; i < documents.length; i++) {
    const docId = documentIds?.[i] || String(i);
    const tf = calculateTF(documents[i]);
    const paperTFIDF = new Map<string, number>();

    for (const [term, tfScore] of tf) {
      const idfScore = idf.get(term) || 0;
      const tfidf = tfScore * idfScore;
      if (tfidf > 0.01) { // Filter low-scoring terms
        paperTFIDF.set(term, tfidf);
      }
    }

    tfidfScores.set(docId, paperTFIDF);
  }

  return tfidfScores;
}

/**
 * Extract top TF-IDF terms for each document
 * @param tfidfScores - TF-IDF scores from calculateTFIDF
 * @param topN - Number of top terms to return per document
 * @returns Map from document ID to top terms
 */
export function extractTopTerms(
  tfidfScores: Map<string, Map<string, number>>,
  topN: number = 5
): Map<string, string[]> {
  const topTerms = new Map<string, string[]>();

  for (const [recid, scores] of tfidfScores) {
    const sorted = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([term]) => term);
    topTerms.set(recid, sorted);
  }

  return topTerms;
}
