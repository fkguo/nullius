import { z } from 'zod';

export type DeterministicJsonRepair = {
  steps: string[];
  repaired_text: string;
  parsed: unknown;
};

function removeTrailingCommas(text: string): string {
  // Safe, semantics-preserving repair for JSON-like text.
  // Removes trailing commas before closing braces/brackets.
  return text.replace(/,\s*([}\]])/g, '$1');
}

function extractFirstCodeFence(text: string): { language?: string; content: string } | null {
  const m = text.match(/```([a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```/);
  if (!m) return null;
  return { language: m[1] ? String(m[1]).toLowerCase() : undefined, content: m[2] ?? '' };
}

function extractFirstBalancedJsonSubstring(text: string): string | null {
  const s = String(text ?? '');
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  if (firstObj === -1 && firstArr === -1) return null;

  const start = (() => {
    if (firstObj === -1) return firstArr;
    if (firstArr === -1) return firstObj;
    return Math.min(firstObj, firstArr);
  })();
  const open = s[start];
  const stack: string[] = [open === '{' ? '}' : ']'];

  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < s.length; i += 1) {
    const ch = s[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\\\') {
        escaped = true;
        continue;
      }
      if (ch === '\"') {
        inString = false;
      }
      continue;
    }

    if (ch === '\"') {
      inString = true;
      continue;
    }

    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      const expected = stack[stack.length - 1];
      if (ch !== expected) continue;
      stack.pop();
      if (stack.length === 0) {
        return s.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function repairAndParseJsonDeterministically(rawText: string): DeterministicJsonRepair {
  const raw = String(rawText ?? '');
  const steps: string[] = [];

  const candidates: Array<{ label: string; text: string }> = [];
  const trimmed = raw.trim();
  if (trimmed) candidates.push({ label: 'raw_trimmed', text: trimmed });

  const fence = extractFirstCodeFence(raw);
  if (fence) {
    steps.push(`extract_code_fence:${fence.language ?? 'unknown'}`);
    const inner = String(fence.content ?? '').trim();
    if (inner) candidates.push({ label: 'code_fence', text: inner });
  }

  const balanced = extractFirstBalancedJsonSubstring(raw);
  if (balanced) candidates.push({ label: 'balanced_substring', text: balanced.trim() });

  const uniq = new Map<string, string>();
  for (const c of candidates) {
    if (!c.text) continue;
    if (uniq.has(c.text)) continue;
    uniq.set(c.text, c.label);
  }

  let lastError: unknown = null;

  for (const [candidateText, label] of uniq.entries()) {
    steps.push(`candidate:${label}`);

    const attempts: Array<{ label: string; text: string }> = [
      { label: 'as_is', text: candidateText },
      { label: 'remove_trailing_commas', text: removeTrailingCommas(candidateText) },
    ];

    for (const a of attempts) {
      steps.push(`repair:${a.label}`);
      try {
        const parsed = JSON.parse(a.text) as unknown;
        return { steps, repaired_text: a.text, parsed };
      } catch (err) {
        lastError = err;
      }
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown_error');
  throw new Error(`Failed to parse JSON from LLM output: ${msg} (steps=${steps.join(' | ')})`);
}

export function parseStructuredJsonOrThrow<T>(params: {
  text: string;
  schema: z.ZodType<T>;
  schema_name: string;
  schema_version: number;
}): { data: T; repair: DeterministicJsonRepair } {
  const repair = repairAndParseJsonDeterministically(params.text);
  const parsed = params.schema.safeParse(repair.parsed);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(
      `Structured output failed schema.parse (schema=${params.schema_name}@${params.schema_version}): ${issueSummary} (steps=${repair.steps.join(' | ')})`
    );
  }
  return { data: parsed.data, repair };
}

