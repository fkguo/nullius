import { z } from 'zod';

export const NumericRecidSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

// Keep digit strings exact, including IDs beyond JavaScript's integer precision.
export const InspireRecidSchema = z.union([
  z.string().regex(/^\s*0*[1-9]\d*\s*$/).transform(id => id.trim()),
  NumericRecidSchema.transform(String),
]);
