import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { findRequiredKeyMismatches } from '@nullius/shared';
import { coreSpecs, isBackground } from '../src/policy.js';
import { extraSchemas, toolsList } from '../src/registry.js';

describe('project transport inputSchema required keys', () => {
  it('required lists exactly the keys whose omission fails to parse, apart from the transport rewrites', () => {
    const tools = toolsList();
    expect(tools.length).toBeGreaterThan(0);
    const issues = tools.flatMap(tool => {
      const extra = (extraSchemas as Record<string, z.ZodType>)[tool.name];
      const schema = extra ?? coreSpecs.find(spec => spec.name === tool.name)?.zodSchema;
      if (!schema) return [`[${tool.name}] no Zod schema`];
      // The transport fills in project_root itself and adds delivery_id for
      // background tools (registry.ts, policy.ts coreArguments); these are the
      // only differences from what the Zod schema alone would require.
      const rewrites = new Set<string>();
      if (!extra) rewrites.add('$: omission fails to parse but not listed in required: project_root');
      if (!extra && isBackground(tool.name)) rewrites.add('$: listed in required but omission parses: delivery_id');
      return findRequiredKeyMismatches(schema, tool.inputSchema)
        .filter(issue => !rewrites.has(issue))
        .map(issue => `[${tool.name}] ${issue}`);
    });
    expect(issues).toEqual([]);
  });

  it('negative control: an omissible key listed in required is reported', () => {
    const tool = toolsList().find(item => item.name === 'project_file_read');
    expect(tool).toBeDefined();
    const tampered = structuredClone(tool!.inputSchema) as { required?: string[] };
    tampered.required = [...(tampered.required ?? []), 'offset'];
    expect(findRequiredKeyMismatches(extraSchemas.project_file_read, tampered)).toEqual([
      '$: listed in required but omission parses: offset',
    ]);
  });
});
