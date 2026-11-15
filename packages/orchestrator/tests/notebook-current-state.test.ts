import { describe, expect, it } from 'vitest';
import {
  CURRENT_STATE_START as START,
  CURRENT_STATE_END as END,
  stripCurrentStateBlock,
  textOutsideNotebookCurrentState,
} from '../src/notebook-current-state.js';

const block = [
  START,
  `<!-- state-digest: ${'a'.repeat(64)} -->`,
  '| Result | Artifact |',
  '|---|---|',
  '| estimate | [value](docs/estimate.md) |',
  END,
].join('\n');

describe('read-only recognition of historical notebook machine content', () => {
  it('leaves a scientific notebook without historical markers intact', () => {
    const notebook = '# 研究笔记\n\n## Estimate\nUsing the stated assumptions, α = 0.12 ± 0.03.\n';
    expect(stripCurrentStateBlock(notebook)).toBe(notebook);
    expect(textOutsideNotebookCurrentState(notebook)).toBe(notebook);
  });

  it('excludes one historical table from a derived view without normalizing authored CRLF text', () => {
    const before = '# 研究笔记\r\n\r\n';
    const after = '\r\n\r\n## Estimate\r\nα = 0.12 ± 0.03; see [derivation](docs/estimate.md).\r\n';
    const notebook = before + block.replace(/\n/g, '\r\n') + after;
    expect(stripCurrentStateBlock(notebook)).toBe(before + after);
    expect(textOutsideNotebookCurrentState(notebook)).toBe(before + after);
    expect(notebook).toContain(block.replace(/\n/g, '\r\n'));
  });

  it.each(['', '(Generated state was not populated.)'])('recognizes an old empty scaffold placeholder: %s', interior => {
    const notebook = `# Notebook\n${START}\n${interior}\n${END}\n## Estimate\nThe derivation remains.\n`;
    expect(stripCurrentStateBlock(notebook)).toBe('# Notebook\n\n## Estimate\nThe derivation remains.\n');
  });

  it.each([
    `${START}\nA scientific derivation: α = 0.12.\n${END}`,
    `${START}\n## Estimate\nα = 0.12.\n${END}`,
    `${START}\n<!-- state-digest: ${'b'.repeat(64)} -->\n## Estimate\nα = 0.12.\n${END}`,
    `${START}\n(See [evidence](docs/estimate.md).)\n${END}`,
    `${START}\n(Estimate\n---\nDetails)\n${END}`,
    `${START}\nScientific text with a missing end marker.`,
    `Scientific text with a missing start marker.\n${END}`,
  ])('keeps ambiguous or scientific marker interiors visible and distinct in source identity: %s', notebook => {
    expect(stripCurrentStateBlock(notebook)).toBe(notebook);
    expect(textOutsideNotebookCurrentState(notebook)).toBeNull();
  });

  it('excludes independent old tables while preserving scientific prose and ambiguous markers between them', () => {
    const before = `## Estimate\n${START}\nA provisional derivation.\n`;
    const between = '\nThe corrected α follows from [this derivation](docs/estimate.md).\n';
    const after = '\nIts validity remains limited to the stated approximation.\n';
    const notebook = before + block + between + block + after;
    expect(stripCurrentStateBlock(notebook)).toBe(before + between + after);
    expect(textOutsideNotebookCurrentState(notebook)).toBeNull();
  });

  it('does not strip an enclosing ambiguous region merely because it starts with a digest', () => {
    const before = `${START}\n<!-- state-digest: ${'b'.repeat(64)} -->\nScientific reasoning before the table.\n`;
    const after = `\nThe scientific reasoning continues.\n${END}`;
    const notebook = before + block + after;
    expect(stripCurrentStateBlock(notebook)).toBe(before + after);
    expect(textOutsideNotebookCurrentState(notebook)).toBeNull();
  });

  it.each([
    `\`\`\`md\n${block}\n\`\`\``,
    `~~~md\n${block}\n~~~`,
    `\`\`\`\`md\n\`\`\`\n${block}\n\`\`\`\``,
    `\`\`\`md\n~~~\n${block}\n\`\`\``,
    block.split('\n').map(line => `    ${line}`).join('\n'),
    block.split('\n').map(line => `\t${line}`).join('\n'),
  ])('does not hide quoted marker examples: %s', example => {
    const notebook = `## Method\nExample syntax:\n\n${example}\n\nThe scientific derivation follows.\n`;
    expect(stripCurrentStateBlock(notebook)).toBe(notebook);
    expect(textOutsideNotebookCurrentState(notebook)).toBe(notebook);
  });
});
