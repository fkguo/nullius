/**
 * Deep Section Writer Types
 */

import type { WritingPacket, SectionOutput, LLMCallMode } from '../types.js';

export interface WriteSectionParams {
  outline: any;
  claims_table: any;
  section_number: string;
  context?: any;
  llm_mode?: LLMCallMode;
  write_mode?: 'full' | 'summary_only';
  draft_mode?: boolean;
}

export interface WriteSectionResult {
  section_output: SectionOutput;
  writing_packet?: WritingPacket;
  mode_used: LLMCallMode;
}
