import * as fs from 'node:fs';
import * as path from 'node:path';

export type SourceContentType = 'section_output' | 'reviewer_report' | 'revision_plan';
export type ReviewContentType = 'reviewer_report' | 'revision_plan';

export type DraftContext = {
  mode: 'seeded_draft' | 'existing_draft';
  draftSourceArtifactName?: string;
  draftSourceContentType?: SourceContentType;
  reviewSourceArtifactName?: string;
  reviewSourceContentType?: ReviewContentType;
};

export type StagedContentArtifact = {
  artifactName: string;
  contentType: SourceContentType;
  stagedAtMs: number | null;
};

type ReviewStagedContentArtifact = StagedContentArtifact & { contentType: ReviewContentType };

const DRAFT_SOURCE_PRIORITY: Record<SourceContentType, number> = {
  section_output: 0,
  reviewer_report: 1,
  revision_plan: 2,
};

const REVIEW_SOURCE_PRIORITY: Record<ReviewContentType, number> = {
  reviewer_report: 0,
  revision_plan: 1,
};

export function slugFor(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'seed';
}

function readStagedContentArtifact(filePath: string, artifactName: string): StagedContentArtifact | null {
  try {
    const stat = fs.statSync(filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      content_type?: unknown;
      staged_at?: unknown;
    };
    const contentType = parsed.content_type;
    if (contentType === 'section_output' || contentType === 'reviewer_report' || contentType === 'revision_plan') {
      const stagedAt = typeof parsed.staged_at === 'string' ? Date.parse(parsed.staged_at) : Number.NaN;
      return {
        artifactName,
        contentType,
        stagedAtMs: Number.isFinite(stagedAt) ? stagedAt : stat.mtimeMs,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isLaterArtifact(
  current: StagedContentArtifact,
  candidate: StagedContentArtifact,
): boolean {
  const currentStagedAt = current.stagedAtMs ?? Number.NEGATIVE_INFINITY;
  const candidateStagedAt = candidate.stagedAtMs ?? Number.NEGATIVE_INFINITY;
  if (candidateStagedAt !== currentStagedAt) {
    return candidateStagedAt > currentStagedAt;
  }
  return candidate.artifactName.localeCompare(current.artifactName) > 0;
}

function preferDraftSource(
  current: StagedContentArtifact | undefined,
  candidate: StagedContentArtifact,
): StagedContentArtifact {
  if (!current) return candidate;
  const currentPriority = DRAFT_SOURCE_PRIORITY[current.contentType];
  const candidatePriority = DRAFT_SOURCE_PRIORITY[candidate.contentType];
  if (candidatePriority !== currentPriority) {
    return candidatePriority < currentPriority ? candidate : current;
  }
  return isLaterArtifact(current, candidate) ? candidate : current;
}

function preferReviewSource(
  current: ReviewStagedContentArtifact | undefined,
  candidate: ReviewStagedContentArtifact,
): ReviewStagedContentArtifact {
  if (!current) return candidate;
  const currentPriority = REVIEW_SOURCE_PRIORITY[current.contentType];
  const candidatePriority = REVIEW_SOURCE_PRIORITY[candidate.contentType];
  if (candidatePriority !== currentPriority) {
    return candidatePriority < currentPriority ? candidate : current;
  }
  return isLaterArtifact(current, candidate) ? candidate : current;
}

export function listStagedContentArtifacts(runDir: string): StagedContentArtifact[] {
  const artifactsDir = path.join(runDir, 'artifacts');
  if (!fs.existsSync(artifactsDir)) {
    return [];
  }
  return fs.readdirSync(artifactsDir)
    .filter(name => name.startsWith('staged_') && name.endsWith('.json'))
    .sort()
    .map(artifactName => readStagedContentArtifact(path.join(artifactsDir, artifactName), artifactName))
    .filter((artifact): artifact is StagedContentArtifact => artifact !== null);
}

export function detectDraftContext(runDir: string): DraftContext {
  const candidates = listStagedContentArtifacts(runDir);
  let draftSource: StagedContentArtifact | undefined;
  let reviewSource: ReviewStagedContentArtifact | undefined;
  for (const candidate of candidates) {
    draftSource = preferDraftSource(draftSource, candidate);
    if (candidate.contentType === 'reviewer_report' || candidate.contentType === 'revision_plan') {
      reviewSource = preferReviewSource(reviewSource, candidate as ReviewStagedContentArtifact);
    }
  }
  if (!draftSource) {
    return { mode: 'seeded_draft' };
  }
  return {
    mode: 'existing_draft',
    draftSourceArtifactName: draftSource.artifactName,
    draftSourceContentType: draftSource.contentType,
    reviewSourceArtifactName: reviewSource?.artifactName,
    reviewSourceContentType: reviewSource?.contentType,
  };
}
