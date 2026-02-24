/**
 * Originality Checker Types
 */

export interface CheckOriginalityParams {
  generated_text: string;
  source_evidences: any[];
  threshold?: number;
}

export interface CheckOriginalityResult {
  level: 'critical' | 'warning' | 'acceptable';
  is_acceptable: boolean;
  needs_review: boolean;
  max_overlap: number;
  flagged_count: number;
}
