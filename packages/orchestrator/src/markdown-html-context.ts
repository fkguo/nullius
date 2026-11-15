/** Track non-prose HTML containers across CommonMark nodes and blocks. */
export function createMarkdownHtmlContext() {
  const excluded = new Set(['pre', 'code', 'script', 'style', 'textarea', 'title', 'xmp',
    'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'template']);
  const rawText = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe',
    'noembed', 'noframes', 'noscript', 'plaintext']);
  let enclosing: string | null = null;
  let depth = 0;
  return {
    get hidden(): boolean { return enclosing !== null; },
    scan(value: string): void {
      // Attributes and comments are opaque outside raw-text containers. Inside
      // one, its closing tag remains meaningful even in comment-looking text.
      const tags = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][a-z\d-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
      let cursor = 0;
      while (cursor < value.length) {
        if (enclosing !== null && rawText.has(enclosing)) {
          if (enclosing === 'plaintext') return;
          const closing = new RegExp(`</${enclosing}[\\t\\n\\f\\r ]*>`, 'gi');
          closing.lastIndex = cursor;
          const match = closing.exec(value);
          if (!match) return;
          cursor = closing.lastIndex;
          enclosing = null; depth = 0;
          continue;
        }
        tags.lastIndex = cursor;
        const match = tags.exec(value);
        if (!match) return;
        cursor = tags.lastIndex;
        if (!match[2]) continue;
        const tag = match[2].toLowerCase();
        if (enclosing !== null) {
          if (tag !== enclosing || tag === 'plaintext') continue;
          if (match[1] && --depth === 0) enclosing = null;
          else if (!match[1] && !rawText.has(tag)) depth++;
        } else if (!match[1] && excluded.has(tag)) {
          enclosing = tag; depth = 1;
        }
      }
    },
  };
}
