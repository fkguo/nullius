export {
  buildCitationNetwork,
  type CitationNetworkParams,
  type CitationNetworkResult,
  type NetworkNode,
  type NetworkEdge,
} from './citationNetwork.js';

export {
  findSeminalPapers,
  type FindSeminalParams,
  type FindSeminalResult,
  type EnhancedSeminalPaper,
  type PaperCategory,
} from './seminalPapers.js';

export {
  buildResearchTimeline,
  type TimelineParams,
  type TimelineResult,
  type TimelinePhase,
} from './timeline.js';

export {
  findConnections,
  type FindConnectionsParams,
  type ConnectionsResult,
} from './findConnections.js';

export {
  findRelatedPapers,
  type FindRelatedParams,
  type RelatedPapers,
} from './findRelated.js';

export {
  researchExpansion,
  type ResearchExpansionParams,
  type ExpansionResult,
} from './expansion.js';

export {
  generateSurvey,
  type GenerateSurveyParams,
  type SurveyResult,
} from './survey.js';

export {
  findEmergingPapers,
  type FindEmergingParams,
  type FindEmergingResult,
  type EmergingPaperResult,
} from './emergingPapers.js';

export {
  findCrossoverTopics,
  type FindCrossoverParams,
  type FindCrossoverResult,
  type CrossoverResult,
} from './crossoverTopics.js';

export {
  analyzeTopicEvolution,
  type TopicEvolutionParams,
  type TopicEvolutionResult,
  type EvolutionPhase,
} from './topicEvolution.js';

export {
  buildCollaborationNetwork,
  type CollaborationNetworkParams,
  type CollaborationNetworkResult,
  type CollaboratorNode,
  type CollaborationEdge,
  type CollaborationCluster,
} from './collaborationNetwork.js';

export {
  getArxivSource,
  type ArxivSourceResult,
  type ArxivMetadata,
} from '@autoresearch/arxiv-mcp/tooling';

// Phase 5 Download Tools
export {
  getDownloadUrls,
  type GetDownloadUrlsParams,
  type GetDownloadUrlsResult,
} from '@autoresearch/arxiv-mcp/tooling';

export {
  getPaperContent,
  type GetPaperContentParams,
} from '../../utils/arxivCompat.js';

export type { GetPaperContentResult } from '@autoresearch/arxiv-mcp/tooling';

// Paper classification
export {
  classifyPapers,
  classifyPaper,
  isReviewPaper,
  isConferencePaper,
  classifyContentType,
  type PaperType,
  type ContentType,
  type ClassifiedPaper,
  type ContentClassification,
} from './paperClassifier.js';

// Original source tracing
export {
  traceOriginalSource,
  type TraceOriginalSourceParams,
  type TraceOriginalSourceResult,
  type TracedSource,
  type SourceConfidence,
} from './traceSource.js';

// Conference paper to journal tracing
export {
  traceToOriginal,
  batchTraceToOriginal,
  type TraceToOriginalParams,
  type TraceToOriginalResult,
  type PaperRelationship,
} from './traceToOriginal.js';

// Phase 7 LaTeX Analysis Tools
export {
  extractTables,
  type ExtractTablesParams,
  type ExtractTablesResult,
} from './extractTables.js';

export {
  extractBibliography,
  type ExtractBibliographyParams,
  type ExtractBibliographyResult,
} from './extractBibliography.js';

export {
  validateBibliography,
  type ValidateBibliographyParams,
  type ValidateBibliographyResult,
} from './validateBibliography.js';

export {
  cleanupDownloads,
  type CleanupDownloadsParams,
  type CleanupDownloadsResult,
} from './cleanupDownloads.js';

export {
  type Section,
  type Equation,
  type Citation,
  type Theorem,
  type TheoremType,
  type Figure,
  type SubFigure,
  type Table,
  type BibEntry,
} from './latex/index.js';

// Phase 8 Deep Research Tools
export {
  deepAnalyze,
  type DeepAnalyzeParams,
  type DeepAnalyzeOptions,
  type DeepAnalyzeResult,
  type DeepPaperAnalysis,
} from './deepAnalyze.js';

export {
  analyzeNewEntrants,
  type NewEntrantParams,
  type NewEntrantAnalysis,
} from './newEntrantRatio.js';

export {
  calculateDisruptionIndex,
  type DisruptionParams,
  type DisruptionResult,
} from './disruptionIndex.js';

export {
  type SociologyMetrics,
} from './emergingPapers.js';

export {
  synthesizeReview,
  type SynthesizeReviewParams,
  type SynthesizeOptions,
  type SynthesizedReview,
  type SynthesizeReviewResult,
  type NarrativeStructure,
  type ReviewStyle,
  type PaperGroup,
} from './synthesizeReview.js';

// Phase 9 Critical Deep Research Tools
export {
  extractMeasurements,
  type MeasurementExtractionParams,
  type MeasurementExtractionResult,
  type Measurement,
} from './measurementExtractor.js';

export {
  gradeEvidence,
  type EvidenceGradingParams,
  type EvidenceGradingResult,
  type EvidenceGrade,
  type EvidenceLevel,
  type ConfidenceLevel,
} from './evidenceGrading.js';

export {
  generateCriticalQuestions,
  type CriticalQuestionsParams,
  type CriticalQuestionsResult,
  type CriticalQuestions,
  type PaperType as CriticalPaperType,
  type RedFlag,
  type RedFlagType,
} from './criticalQuestions.js';

export {
  classifyReviews,
  type ClassifyReviewsParams,
  type ClassifyReviewsResult,
  type ReviewClassification,
  type ReviewType,
  type CoverageScope,
  type Recency,
} from './reviewClassifier.js';

export {
  detectConflicts,
  type ConflictDetectionParams,
  type ConflictDetectionResult,
  type ConflictAnalysis,
  type ConflictType,
  type CompatibleGroup,
} from './conflictDetector.js';

export {
  trackAssumptions,
  type AssumptionTrackerParams,
  type AssumptionTrackerResult,
  type AssumptionChain,
  type AssumptionNode,
  type AssumptionType,
  type AssumptionSource,
  type ValidationStatus as AssumptionValidationStatus,
} from './assumptionTracker.js';

export {
  performCriticalAnalysis,
  type CriticalAnalysisParams,
  type CriticalAnalysisResult,
} from './criticalAnalysis.js';

export {
  validatePhysics,
  PHYSICS_AXIOMS,
  type PhysicsAxiom,
  type PhysicsContent,
  type ValidationResult,
  type ValidationReport,
  type ValidationOptions,
  type ValidationStatus as PhysicsValidationStatus,
  type AxiomSeverity,
  type AxiomCategory,
  type Violation,
  type OverallStatus,
} from './physicsValidator.js';

// M2: Unified LaTeX parsing tool
export {
  parseLatexContent,
  type ParseLatexContentParams,
  type ParseLatexOptions,
  type ParseLatexContentResult,
  type ComponentType,
} from './parseLatexContent.js';

// ─────────────────────────────────────────────────────────────────────────────
// Consolidated Tools (Tool Consolidation Phase)
// ─────────────────────────────────────────────────────────────────────────────

// Topic Analysis (3→1): timeline + evolution + emerging
export {
  analyzeTopicUnified,
  type TopicAnalysisParams,
  type TopicAnalysisOptions,
  type TopicAnalysisResult,
  type TopicAnalysisMode,
} from './topicAnalysis.js';

// Discover Papers (4→1): seminal + related + expansion + survey
export {
  discoverPapers,
  type DiscoverPapersParams,
  type DiscoverOptions,
  type DiscoverPapersResult,
  type DiscoverMode,
} from './discoverPapers.js';

// Network Analysis (2→1): citation + collaboration
export {
  analyzeNetwork,
  type NetworkAnalysisParams,
  type NetworkOptions,
  type NetworkAnalysisResult,
  type NetworkMode,
} from './networkAnalysis.js';

// Critical Research (4→1): evidence + conflicts + analysis + reviews
export {
  performCriticalResearch,
  type CriticalResearchParams,
  type CriticalOptions,
  type CriticalResearchResult,
  type CriticalMode,
} from './criticalResearch.js';

// Paper Source (3→1): urls + content + metadata
export {
  accessPaperSource,
} from '../../utils/arxivCompat.js';

export type {
  PaperSourceParams,
  SourceOptions,
  PaperSourceResult,
  SourceMode,
} from '@autoresearch/arxiv-mcp/tooling';

// Deep Research (2→1): analyze + synthesize
export {
  performDeepResearch,
  type DeepResearchParams,
  type DeepOptions,
  type DeepResearchResult,
  type DeepMode,
} from './deepResearch.js';

// Field Survey: physicist's literature review workflow
export {
  performFieldSurvey,
  type FieldSurveyParams,
  type FieldSurveyResult,
  type ReviewPaper,
  type SeminalPaper,
  type CitationCluster as FieldSurveyCitationCluster,
  type Controversy,
  type OpenQuestion,
} from './fieldSurvey.js';

// Stance Detection (Phase 2)
export {
  analyzeStanceFromLatex,
  type StancePipelineInput,
  type StancePipelineOptions,
  type StancePipelineResult,
  type CitationContextWithStance,
  type AggregatedStance,
  type PipelineError,
  type ResolutionMethod,
} from './stance/index.js';

// Citation Momentum
export {
  calculateMomentum,
  batchCalculateMomentum,
  type CitationMomentum,
  type EmergingPaper,
} from './citationMomentum.js';
