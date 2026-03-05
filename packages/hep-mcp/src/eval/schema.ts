import { z } from 'zod';

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  input: z.unknown(),
  expected: z.unknown(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const EvalSetSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().min(1),
  module: z.string().min(1),
  cases: z.array(EvalCaseSchema).min(1),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalSet = z.infer<typeof EvalSetSchema>;
