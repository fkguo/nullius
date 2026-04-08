import fs from 'fs';
import path from 'path';

const SOURCE_DIR = 'tmp/rmpsource';
const OUTPUT_FILE = 'packages/hep-mcp/src/tools/writing/corpus/rmp_analysis_results.json';

interface PaperStats {
  id: string;
  title?: string;
  sections: string[];
  abstractLength: number;
  totalWords: number;
  citationCount: number;
  equationCount: number;
  phrases: Record<string, number>;
}

const INTERESTING_PHRASES = [
  "in this review",
  "we review",
  "we discuss",
  "we summarize",
  "it is well known",
  "it is important to note",
  "recent progress",
  "open question",
  "future direction",
  "outlook",
  "conclusions",
  "summary",
  "introduction",
  "background",
  "framework"
];

function findTexFiles(dir: string): string[] {
  let results: string[] = [];
  try {
    const list = fs.readdirSync(dir);
    list.forEach(file => {
      file = path.join(dir, file);
      const stat = fs.statSync(file);
      if (stat && stat.isDirectory()) {
        results = results.concat(findTexFiles(file));
      } else {
        if (file.endsWith('.tex')) {
          results.push(file);
        }
      }
    });
  } catch (e) {
    // ignore errors
  }
  return results;
}

async function analyzePaper(dirPath: string): Promise<PaperStats | null> {
  const texFiles = findTexFiles(dirPath);
  
  if (texFiles.length === 0) return null;

  // Heuristic: largest tex file is likely the main one
  let mainFile = texFiles[0];
  let maxSize = 0;
  for (const file of texFiles) {
    const stats = fs.statSync(file);
    if (stats.size > maxSize) {
      maxSize = stats.size;
      mainFile = file;
    }
  }

  const content = fs.readFileSync(mainFile, 'utf-8');
  const id = path.basename(dirPath);

  // Extract Title
  const titleMatch = content.match(/\\title\{([^}]+)\}/);
  const title = titleMatch ? titleMatch[1] : undefined;

  // Extract Sections
  const sectionMatches = content.matchAll(/\\section\{([^}]+)\}/g);
  const sections = Array.from(sectionMatches).map(m => m[1]);

  // Abstract Length (rough)
  const abstractMatch = content.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
  const abstractText = abstractMatch ? abstractMatch[1] : '';
  const abstractLength = abstractText.split(/\s+/).length;

  // Word Count (very rough, ignoring latex commands)
  const cleanText = content.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1').replace(/\\[a-zA-Z]+/g, '');
  const totalWords = cleanText.split(/\s+/).length;

  // Counts
  const citationCount = (content.match(/\\cite/g) || []).length;
  const equationCount = (content.match(/\\begin\{equation\}/g) || []).length + (content.match(/\\begin\{align\}/g) || []).length;

  // Phrase Frequency
  const phrases: Record<string, number> = {};
  const lowerContent = content.toLowerCase();
  for (const phrase of INTERESTING_PHRASES) {
    const count = (lowerContent.match(new RegExp(phrase, 'g')) || []).length;
    if (count > 0) {
      phrases[phrase] = count;
    }
  }

  return {
    id,
    title,
    sections,
    abstractLength,
    totalWords,
    citationCount,
    equationCount,
    phrases
  };
}

async function main() {
  console.log(`Analyzing papers in ${SOURCE_DIR}...`);
  
  // Ensure output dir exists
  const outputDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let paperDirs: string[] = [];
  try {
    paperDirs = fs.readdirSync(SOURCE_DIR).map(f => path.join(SOURCE_DIR, f));
  } catch (e) {
    console.error(`Could not read source directory: ${SOURCE_DIR}`);
    return;
  }

  const results: PaperStats[] = [];

  for (const dir of paperDirs) {
    if (fs.statSync(dir).isDirectory()) {
      try {
        const stats = await analyzePaper(dir);
        if (stats) {
          results.push(stats);
        }
      } catch (e) {
        // console.error(`Failed to analyze ${dir}:`, e);
      }
    }
  }

  console.log(`Analyzed ${results.length} papers.`);

  // Aggregate stats
  const aggregation = {
    totalPapers: results.length,
    avgAbstractLength: results.reduce((acc, p) => acc + p.abstractLength, 0) / (results.length || 1),
    avgWordCount: results.reduce((acc, p) => acc + p.totalWords, 0) / (results.length || 1),
    avgCitations: results.reduce((acc, p) => acc + p.citationCount, 0) / (results.length || 1),
    commonSections: {} as Record<string, number>,
    commonPhrases: {} as Record<string, number>
  };

  results.forEach(p => {
    p.sections.forEach(s => {
      // Clean section titles: remove labels, lowercase, trim
      const cleanS = s.replace(/\\label\{.*?\}/, '').trim().toLowerCase();
      aggregation.commonSections[cleanS] = (aggregation.commonSections[cleanS] || 0) + 1;
    });
    Object.entries(p.phrases).forEach(([phrase, count]) => {
      aggregation.commonPhrases[phrase] = (aggregation.commonPhrases[phrase] || 0) + count;
    });
  });

  // Sort common sections
  const sortedSections = Object.entries(aggregation.commonSections)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 20);
    
  const finalOutput = {
    aggregation: {
        ...aggregation,
        commonSections: Object.fromEntries(sortedSections)
    },
    papers: results
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalOutput, null, 2));
  console.log(`Results written to ${OUTPUT_FILE}`);
}

main();
