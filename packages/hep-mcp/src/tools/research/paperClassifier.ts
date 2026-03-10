import type { PaperSummary } from '@autoresearch/shared';
import type { SemanticAssessmentProvenance } from './semantic/semanticProvenance.js';
import { withSignals } from './semantic/semanticProvenance.js';

export type PaperType = 'original' | 'review' | 'conference' | 'thesis' | 'lecture' | 'uncertain';
export type ContentType = 'experimental' | 'theoretical' | 'review' | 'mixed' | 'uncertain';

export interface ReviewPaperAssessment {
  isReview: boolean;
  confidence: number;
  decision: 'review' | 'not_review' | 'uncertain';
  provenance: SemanticAssessmentProvenance;
}

export interface ConferencePaperAssessment {
  isConference: boolean;
  confidence: number;
  decision: 'conference' | 'not_conference' | 'uncertain';
  provenance: SemanticAssessmentProvenance;
}

export interface ClassifiedPaper extends PaperSummary {
  paper_type: PaperType;
  is_review: boolean;
  is_conference: boolean;
  type_confidence: number;
  paper_type_provenance: SemanticAssessmentProvenance;
  review_classification: ReviewPaperAssessment;
  conference_classification: ConferencePaperAssessment;
}

export interface ContentClassification {
  content_type: ContentType;
  confidence: number;
  experimental_score: number;
  theoretical_score: number;
  method: 'metadata' | 'arxiv' | 'default';
  provenance: SemanticAssessmentProvenance;
}

const REVIEW_MARKERS = ['review'];
const CONFERENCE_MARKERS = ['conference', 'proceedings'];
const THESIS_MARKERS = ['thesis'];
const LECTURE_MARKERS = ['lecture', 'lectures'];
const ARTICLE_MARKERS = ['article'];

// Provider-local arXiv metadata prior for hep-mcp content hints only; this is not a
// generic semantic taxonomy and it does not decide final paper/review authority paths.
const ARXIV_EXPERIMENTAL_CATEGORIES = ['hep-ex', 'nucl-ex', 'physics.ins-det', 'astro-ph.im', 'astro-ph.he'];
const ARXIV_THEORETICAL_CATEGORIES = ['hep-th', 'hep-ph', 'nucl-th', 'gr-qc', 'astro-ph.co', 'quant-ph', 'cond-mat.str-el', 'math-ph'];
const ARXIV_MIXED_CATEGORIES = ['hep-lat', 'astro-ph.ga', 'astro-ph.sr'];

function normalize(values?: string[]): string[] {
  return (values ?? []).map(value => value.toLowerCase().trim()).filter(Boolean);
}

function includesMarker(values: string[], markers: string[]): string[] {
  return values.filter(value => markers.some(marker => value.includes(marker)));
}

function articleLikeMetadata(paper: PaperSummary): string[] {
  const publicationTypes = normalize(paper.publication_type);
  const documentTypes = normalize(paper.document_type);
  const signals = [
    ...includesMarker(publicationTypes, ARTICLE_MARKERS),
    ...includesMarker(documentTypes, ARTICLE_MARKERS),
  ];
  return withSignals(signals) ?? [];
}

export function isConferencePaper(paper: PaperSummary): ConferencePaperAssessment {
  const publicationTypes = normalize(paper.publication_type);
  const documentTypes = normalize(paper.document_type);
  const conferenceSignals = [
    ...includesMarker(publicationTypes, CONFERENCE_MARKERS),
    ...includesMarker(documentTypes, CONFERENCE_MARKERS),
  ];

  if (conferenceSignals.length > 0) {
    return {
      isConference: true,
      confidence: 1,
      decision: 'conference',
      provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'document_type', signals: conferenceSignals },
    };
  }

  const negativeSignals = [
    ...includesMarker(publicationTypes, REVIEW_MARKERS),
    ...includesMarker(publicationTypes, THESIS_MARKERS),
    ...includesMarker(publicationTypes, LECTURE_MARKERS),
    ...includesMarker(documentTypes, ARTICLE_MARKERS),
  ];
  if (negativeSignals.length > 0) {
    return {
      isConference: false,
      confidence: 0.85,
      decision: 'not_conference',
      provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'document_type_negative', signals: negativeSignals },
    };
  }

  return {
    isConference: false,
    confidence: 0,
    decision: 'uncertain',
    provenance: { backend: 'diagnostic_fallback', status: 'unavailable', used_fallback: true, reason_code: 'insufficient_metadata' },
  };
}

export function isReviewPaper(paper: PaperSummary): ReviewPaperAssessment {
  const publicationTypes = normalize(paper.publication_type);
  const documentTypes = normalize(paper.document_type);
  const reviewSignals = includesMarker(publicationTypes, REVIEW_MARKERS);

  if (reviewSignals.length > 0) {
    return {
      isReview: true,
      confidence: 1,
      decision: 'review',
      provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'publication_type', signals: reviewSignals },
    };
  }

  const negativeSignals = [
    ...includesMarker(publicationTypes, CONFERENCE_MARKERS),
    ...includesMarker(publicationTypes, THESIS_MARKERS),
    ...includesMarker(publicationTypes, LECTURE_MARKERS),
    ...includesMarker(documentTypes, CONFERENCE_MARKERS),
    ...includesMarker(documentTypes, ARTICLE_MARKERS),
  ];
  if (negativeSignals.length > 0) {
    return {
      isReview: false,
      confidence: 0.8,
      decision: 'not_review',
      provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'publication_type_negative', signals: negativeSignals },
    };
  }

  return {
    isReview: false,
    confidence: 0,
    decision: 'uncertain',
    provenance: { backend: 'diagnostic_fallback', status: 'unavailable', used_fallback: true, reason_code: 'insufficient_metadata' },
  };
}

function classifyDocumentRole(paper: PaperSummary): { paper_type: PaperType; confidence: number; provenance: SemanticAssessmentProvenance } {
  const publicationTypes = normalize(paper.publication_type);
  const documentTypes = normalize(paper.document_type);
  const review = isReviewPaper(paper);
  const conference = isConferencePaper(paper);

  if (review.decision === 'review') return { paper_type: 'review', confidence: review.confidence, provenance: review.provenance };
  if (conference.decision === 'conference') return { paper_type: 'conference', confidence: conference.confidence, provenance: conference.provenance };

  const thesisSignals = [
    ...includesMarker(publicationTypes, THESIS_MARKERS),
    ...includesMarker(documentTypes, THESIS_MARKERS),
  ];
  if (thesisSignals.length > 0) {
    return { paper_type: 'thesis', confidence: 0.95, provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'thesis_metadata', signals: thesisSignals } };
  }

  const lectureSignals = [
    ...includesMarker(publicationTypes, LECTURE_MARKERS),
    ...includesMarker(documentTypes, LECTURE_MARKERS),
  ];
  if (lectureSignals.length > 0) {
    return { paper_type: 'lecture', confidence: 0.9, provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'lecture_metadata', signals: lectureSignals } };
  }

  const originalSignals = articleLikeMetadata(paper);
  if (review.decision === 'not_review' && conference.decision === 'not_conference' && originalSignals.length > 0) {
    return { paper_type: 'original', confidence: 0.7, provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'article_metadata', signals: originalSignals } };
  }

  return {
    paper_type: 'uncertain',
    confidence: 0,
    provenance: { backend: 'diagnostic_fallback', status: 'unavailable', used_fallback: true, reason_code: 'insufficient_metadata' },
  };
}

export function classifyPaper(paper: PaperSummary): ClassifiedPaper {
  const reviewClassification = isReviewPaper(paper);
  const conferenceClassification = isConferencePaper(paper);
  const role = classifyDocumentRole(paper);
  return {
    ...paper,
    paper_type: role.paper_type,
    is_review: reviewClassification.decision === 'review',
    is_conference: conferenceClassification.decision === 'conference',
    type_confidence: role.confidence,
    paper_type_provenance: role.provenance,
    review_classification: reviewClassification,
    conference_classification: conferenceClassification,
  };
}

export function classifyPapers(papers: PaperSummary[]): ClassifiedPaper[] {
  return papers.map(classifyPaper);
}

export function classifyContentType(paper: PaperSummary): ContentClassification {
  const review = isReviewPaper(paper);
  if (review.decision === 'review') {
    return {
      content_type: 'review',
      confidence: review.confidence,
      experimental_score: 0,
      theoretical_score: 0,
      method: 'metadata',
      provenance: review.provenance,
    };
  }

  const categories = [paper.arxiv_primary_category, ...(paper.arxiv_categories ?? [])]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.toLowerCase());
  if (categories.length === 0) {
    return {
      content_type: 'uncertain',
      confidence: 0,
      experimental_score: 0,
      theoretical_score: 0,
      method: 'default',
      provenance: { backend: 'diagnostic_fallback', status: 'unavailable', used_fallback: true, reason_code: 'missing_arxiv_categories' },
    };
  }

  const experimental = categories.filter(category => ARXIV_EXPERIMENTAL_CATEGORIES.includes(category)).length;
  const theoretical = categories.filter(category => ARXIV_THEORETICAL_CATEGORIES.includes(category)).length;
  const mixed = categories.filter(category => ARXIV_MIXED_CATEGORIES.includes(category)).length;
  const total = experimental + theoretical + mixed;

  if (mixed > 0 || (experimental > 0 && theoretical > 0)) {
    return {
      content_type: 'mixed',
      confidence: 0.9,
      experimental_score: total > 0 ? experimental / total : 0.5,
      theoretical_score: total > 0 ? theoretical / total : 0.5,
      method: 'arxiv',
      provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'arxiv_category', signals: withSignals(categories) },
    };
  }
  if (experimental > 0) {
    return {
      content_type: 'experimental',
      confidence: 0.95,
      experimental_score: 1,
      theoretical_score: 0,
      method: 'arxiv',
      provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'arxiv_category', signals: withSignals(categories) },
    };
  }
  if (theoretical > 0) {
    return {
      content_type: 'theoretical',
      confidence: 0.95,
      experimental_score: 0,
      theoretical_score: 1,
      method: 'arxiv',
      provenance: { backend: 'metadata', status: 'metadata', used_fallback: false, reason_code: 'arxiv_category', signals: withSignals(categories) },
    };
  }

  return {
    content_type: 'uncertain',
    confidence: 0,
    experimental_score: 0,
    theoretical_score: 0,
    method: 'default',
    provenance: { backend: 'diagnostic_fallback', status: 'unavailable', used_fallback: true, reason_code: 'noncanonical_arxiv_categories', signals: withSignals(categories) },
  };
}
