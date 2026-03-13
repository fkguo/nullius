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

function readStagedContentType(filePath: string): SourceContentType | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { content_type?: unknown };
    const contentType = parsed.content_type;
    if (contentType === 'section_output' || contentType === 'reviewer_report' || contentType === 'revision_plan') {
      return contentType;
    }
  } catch {
    return null;
  }
  return null;
}

function preferDraftSource(
  current: { artifactName: string; contentType: SourceContentType } | undefined,
  candidate: { artifactName: string; contentType: SourceContentType },
): { artifactName: string; contentType: SourceContentType } {
  if (!current) return candidate;
  const currentPriority = DRAFT_SOURCE_PRIORITY[current.contentType];
  const candidatePriority = DRAFT_SOURCE_PRIORITY[candidate.contentType];
  if (candidatePriority !== currentPriority) {
    return candidatePriority < currentPriority ? candidate : current;
  }
  return candidate.artifactName.localeCompare(current.artifactName) < 0 ? candidate : current;
}

function preferReviewSource(
  current: { artifactName: string; contentType: ReviewContentType } | undefined,
  candidate: { artifactName: string; contentType: ReviewContentType },
): { artifactName: string; contentType: ReviewContentType } {
  if (!current) return candidate;
  const currentPriority = REVIEW_SOURCE_PRIORITY[current.contentType];
  const candidatePriority = REVIEW_SOURCE_PRIORITY[candidate.contentType];
  if (candidatePriority !== currentPriority) {
    return candidatePriority < currentPriority ? candidate : current;
  }
  return candidate.artifactName.localeCompare(current.artifactName) < 0 ? candidate : current;
}

export function detectDraftContext(runDir: string): DraftContext {
  const artifactsDir = path.join(runDir, 'artifacts');
  if (!fs.existsSync(artifactsDir)) {
    return { mode: 'seeded_draft' };
  }
  const candidates = fs.readdirSync(artifactsDir).filter(name => name.startsWith('staged_') && name.endsWith('.json')).sort();
  let draftSource: { artifactName: string; contentType: SourceContentType } | undefined;
  let reviewSource: { artifactName: string; contentType: ReviewContentType } | undefined;
  for (const artifactName of candidates) {
    const contentType = readStagedContentType(path.join(artifactsDir, artifactName));
    if (!contentType) continue;
    draftSource = preferDraftSource(draftSource, { artifactName, contentType });
    if (contentType === 'reviewer_report' || contentType === 'revision_plan') {
      reviewSource = preferReviewSource(reviewSource, { artifactName, contentType });
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
