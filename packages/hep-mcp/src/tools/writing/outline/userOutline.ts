import type { OutlineSection } from './types.js';

type ParsedLine = { level: number; title: string };

function normalizeLineEndings(text: string): string {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

function parseOutlineLines(markdown: string): ParsedLine[] {
  const lines = normalizeLineEndings(markdown).split('\n');
  const out: ParsedLine[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      if (title) out.push({ level, title });
      continue;
    }

    const numbered = line.match(/^(\d+(?:\.\d+)*)\s*[\.)]\s+(.+)$/);
    if (numbered) {
      const segs = numbered[1].split('.').filter(Boolean);
      const level = Math.max(1, segs.length);
      const title = numbered[2].trim();
      if (title) out.push({ level, title });
    }
  }

  return out;
}

function normalizeMinLevel(items: ParsedLine[]): ParsedLine[] {
  if (items.length === 0) return [];
  const min = Math.min(...items.map(i => i.level));
  if (min <= 1) return items;
  return items.map(i => ({ ...i, level: Math.max(1, i.level - (min - 1)) }));
}

type OutlineNode = { title: string; children: OutlineNode[] };

function buildTree(items: ParsedLine[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: Array<{ level: number; node: OutlineNode }> = [];

  for (const item of items) {
    const node: OutlineNode = { title: item.title, children: [] };

    while (stack.length > 0 && stack[stack.length - 1]!.level >= item.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1]!.node.children.push(node);
    }

    stack.push({ level: item.level, node });
  }

  return roots;
}

function renumberSections(sections: OutlineSection[], parentNumber?: string): void {
  for (let i = 0; i < sections.length; i++) {
    const newNumber = parentNumber ? `${parentNumber}.${i + 1}` : String(i + 1);
    sections[i].number = newNumber;
    if (sections[i].subsections) renumberSections(sections[i].subsections!, newNumber);
  }
}

function assignTypesRecursively(sections: OutlineSection[]): void {
  for (const sec of sections) {
    const parentType = sec.type;
    if (sec.subsections) {
      for (const child of sec.subsections) child.type = parentType;
      assignTypesRecursively(sec.subsections);
    }
  }
}

export function parseUserOutlineMarkdown(markdown: string): { outline: OutlineSection[]; warnings: string[] } {
  const warnings: string[] = [];
  const lines = normalizeMinLevel(parseOutlineLines(markdown));
  if (lines.length === 0) {
    return { outline: [], warnings: ['No outline sections detected (expected headings like "# Title" or numbered lines like "1. Title")'] };
  }

  const tree = buildTree(lines);
  const nodeToSection = (node: OutlineNode): OutlineSection => ({
    number: '0',
    title: node.title,
    type: 'body',
    assigned_claims: [],
    assigned_figures: [],
    assigned_equations: [],
    assigned_tables: [],
    subsections: node.children.length > 0 ? node.children.map(nodeToSection) : undefined,
  });
  const outline: OutlineSection[] = tree.map(nodeToSection);

  const top = outline.length;
  if (top < 2) warnings.push('Outline has fewer than 2 top-level sections; consider adding a summary/conclusion section.');
  if (top > 25) warnings.push('Outline has many top-level sections; consider consolidating for readability.');

  // Default: first=Introduction, last=Summary; others=Body. Subsections inherit parent type.
  if (top >= 1) outline[0]!.type = 'introduction';
  if (top >= 2) outline[top - 1]!.type = 'summary';
  for (let i = 1; i < top - 1; i++) outline[i]!.type = 'body';

  assignTypesRecursively(outline);
  renumberSections(outline);

  return { outline, warnings };
}
