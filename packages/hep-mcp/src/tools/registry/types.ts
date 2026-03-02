import { z } from 'zod';
import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRiskLevel } from '@autoresearch/shared';

export type ToolExposureMode = 'standard' | 'full';
export type ToolExposure = 'standard' | 'full';
export type ToolTier = 'core' | 'consolidated' | 'advanced' | 'writing';
export type ToolMaturity = 'stable' | 'experimental' | 'deprecated';

export interface ToolHandlerContext {
  reportProgress?: (progress: number, total?: number, message?: string) => void;
  rawArgs?: Record<string, unknown>;
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
}

export interface ToolSpec<TSchema extends z.ZodType<any, any> = z.ZodType<any, any>> {
  name: string;
  description: string;
  tier: ToolTier;
  intent?: string;
  maturity?: ToolMaturity;
  exposure: ToolExposure;
  riskLevel: ToolRiskLevel;
  zodSchema: TSchema;
  handler: (params: z.output<TSchema>, ctx: ToolHandlerContext) => Promise<unknown>;
}

export function isToolExposed(spec: ToolSpec, mode: ToolExposureMode): boolean {
  return mode === 'full' ? true : spec.exposure === 'standard';
}

export function isAdvancedToolSpec(spec: ToolSpec): boolean {
  return spec.tier === 'advanced';
}
