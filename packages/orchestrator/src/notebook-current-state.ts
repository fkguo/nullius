import { locateManagedBlock, textOutsideManagedBlock } from './managed-block.js';

/** Read-only recognition of machine blocks stored by earlier notebook writers.
 * Scientific consumers must not count a historical status table as authored
 * explanation. No current state is rendered, validated or written here. */
export const CURRENT_STATE_START = '<!-- NOTEBOOK_CURRENT_STATE_START -->';
export const CURRENT_STATE_END = '<!-- NOTEBOOK_CURRENT_STATE_END -->';

const NOTEBOOK_BLOCK_SPEC = {
  startMarker: CURRENT_STATE_START,
  endMarker: CURRENT_STATE_END,
  digestFirstLinePattern: /^ {0,3}<!--\s*state-digest:\s*[0-9a-f]{64}\s*--> *$/,
  frontMatterPosition: false,
};

/** Preserve the original byte view outside one unambiguous historical block.
 * Ambiguous markers cannot hide authored content or establish a provenance
 * equivalence. The original file is never modified. */
export function textOutsideNotebookCurrentState(text: string): string | null {
  return textOutsideManagedBlock(text, NOTEBOOK_BLOCK_SPEC);
}

/** Exclude independently recognized historical tables from a derived link
 * view. Ambiguous regions and the prose between complete tables stay visible;
 * this view is never used as the full-text review or source-identity input. */
export function stripCurrentStateBlock(text: string): string {
  const { recognizedBlocks } = locateManagedBlock(text, NOTEBOOK_BLOCK_SPEC);
  let view = text;
  for (const block of [...recognizedBlocks].sort((a, b) => b.start - a.start)) {
    view = view.slice(0, block.start) + view.slice(block.end);
  }
  return view;
}
