// Identifiers
export {
  IdentifierTypeSchema,
  PaperIdentifiersSchema,
  AuthorIdentifiersSchema,
  type IdentifierType,
  type PaperIdentifiers,
  type AuthorIdentifiers,
} from './identifiers.js';

// Author
export {
  AuthorSchema,
  AdvisorInfoSchema,
  AuthorProfileSchema,
  AuthorStatsSchema,
  type Author,
  type AdvisorInfo,
  type AuthorProfile,
  type AuthorStats,
} from './author.js';

// Paper
export {
  PublicationInfoSchema,
  DocumentLinkSchema,
  PaperSummarySchema,
  PaperSchema,
  type PublicationInfo,
  type DocumentLink,
  type PaperSummary,
  type Paper,
} from './paper.js';

// Common
export {
  PaginationParamsSchema,
  PaginatedResultSchema,
  OutputFormatSchema,
  FormatOptionsSchema,
  type PaginationParams,
  type PaginatedResult,
  type OutputFormat,
  type FormatOptions,
} from './common.js';

// Workflow task projection (N2 batch 1/2)
export {
  WorkflowTaskArtifactRefSchema,
  WorkflowTaskPreconditionSchema,
  WorkflowTaskProjectionInputSchema,
  WorkflowTaskKindSchema,
  WorkflowStepTaskProjectionSchema,
  buildWorkflowStepTaskProjection,
  deriveWorkflowTaskIntent,
  type WorkflowTaskArtifactRef,
  type WorkflowTaskPrecondition,
  type WorkflowTaskProjectionInput,
  type WorkflowTaskKind,
  type WorkflowStepTaskProjection,
} from './task-projection.js';

// Semantic assessment contracts
export {
  SemanticAssessmentBackendSchema,
  SemanticAssessmentStatusSchema,
  SemanticAssessmentAuthoritySchema,
  SemanticAssessmentProvenanceSchema,
  type SemanticAssessmentBackend,
  type SemanticAssessmentStatus,
  type SemanticAssessmentAuthority,
  type SemanticAssessmentProvenance,
} from './semantic-assessment.js';

// Semantic grouping contracts
export {
  GroupingProvenanceModeSchema,
  GroupingProvenanceSchema,
  GroupingAssignmentDetailSchema,
  SemanticClusterSchema,
  CollectionSemanticGroupingSchema,
  type GroupingProvenanceMode,
  type GroupingProvenance,
  type GroupingAssignmentDetail,
  type SemanticCluster,
  type CollectionSemanticGrouping,
} from './collection-semantic-grouping.js';

// Methodology challenge contracts
export {
  MethodologyChallengeModeSchema,
  MethodologyChallengeExtractionStatusSchema,
  MethodologyChallengeExtractionProvenanceSchema,
  ExtractedMethodologyChallengeSchema,
  MethodologyChallengeExtractionResultSchema,
  type MethodologyChallengeMode,
  type MethodologyChallengeExtractionStatus,
  type MethodologyChallengeExtractionProvenance,
  type ExtractedMethodologyChallenge,
  type MethodologyChallengeExtractionResult,
} from './methodology-challenges.js';

// Params
export {
  InspireSearchParamsSchema,
  LookupByIdParamsSchema,
  SearchAuthorParamsSchema,
  SearchTitleParamsSchema,
  GetBibtexParamsSchema,
  type InspireSearchParams,
  type LookupByIdParams,
  type SearchAuthorParams,
  type SearchTitleParams,
  type GetBibtexParams,
} from './params.js';

// Network
export {
  CitationNetworkParamsSchema,
  NetworkNodeSchema,
  EdgeSchema,
  CitationNetworkSchema,
  type CitationNetworkParams,
  type NetworkNode,
  type Edge,
  type CitationNetwork,
} from './network.js';

// Analysis Types (consolidated — NEW-R06)
// Handwritten Zod exports remain the live TS/runtime authority for the
// analysis-tool path; generated analysis-types-v1 stays a codegen artifact.
export {
  AnalysisTypeSchema,
  RelatedStrategySchema,
  ExpansionDirectionSchema,
  SurveyGoalSchema,
  SurveyPrioritizeSchema,
  AnalyzePapersParamsSchema,
  AnalyzeCollectionParamsSchema,
  FindConnectionsParamsSchema,
  FindRelatedParamsSchema,
  ResearchExpansionParamsSchema,
  GenerateSurveyParamsSchema,
  TopicEvolutionParamsSchema,
  BatchImportParamsSchema,
  CollectionAnalysisSchema,
  ConnectionsResultSchema,
  RelatedPapersSchema,
  ExpansionResultSchema,
  SurveyResultSchema,
  TopicEvolutionSchema,
  BatchImportResultSchema,
  type AnalysisType,
  type RelatedStrategy,
  type ExpansionDirection,
  type SurveyGoal,
  type SurveyPrioritize,
  type AnalyzePapersParams,
  type AnalyzeCollectionParams,
  type FindConnectionsParams,
  type FindRelatedParams,
  type ResearchExpansionParams,
  type GenerateSurveyParams,
  type TopicEvolutionParams,
  type BatchImportParams,
  type CollectionAnalysis,
  type ConnectionsResult,
  type RelatedPapers,
  type ExpansionResult,
  type SurveyResult,
  type TopicEvolution,
  type BatchImportResult,
} from './analysis-types.js';

// Writing (Phase 10)
export {
  // Journal Styles
  JournalStyleSchema,
  type JournalStyle,
  // Evidence & Claims
  EvidenceLocatorSchema,
  EvidenceSnippetSchema,
  ClaimStanceSchema,
  EvidenceGradeSchema,
  ClaimSchema,
  type EvidenceLocator,
  type EvidenceSnippet,
  type ClaimStance,
  type EvidenceGrade,
  type Claim,
  // Corpus
  CorpusPaperSchema,
  CorpusSnapshotSchema,
  type CorpusPaper,
  type CorpusSnapshot,
  // Disagreement Graph
  DisagreementNodeSchema,
  DisagreementEdgeSchema,
  DisagreementGraphSchema,
  type DisagreementNode,
  type DisagreementEdge,
  type DisagreementGraph,
  // Claims Table (SSOT)
  ClaimsTableSchema,
  type ClaimsTable,
  // Writing Outline
  OutlineSectionSchema,
  WritingOutlineSchema,
  type OutlineSection,
  type WritingOutline,
  // Style Rules
  SentencePatternSchema,
  JournalStyleRulesSchema,
  type SentencePattern,
  type JournalStyleRules,
  // Quality Checks
  QualityCheckResultSchema,
  QualityAssessmentSchema,
  type QualityCheckResult,
  type QualityAssessment,
} from './writing.js';
