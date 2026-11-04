/** Just enough Markdown to read a prompt file: headings, bullets, bold. No HTML is produced;
 *  the template renders the parts as text, so nothing in a prompt can inject markup. */
export interface MdPart {
  text: string;
  bold: boolean;
}

export interface MdBlock {
  kind: 'heading' | 'item' | 'para';
  depth: number;
  parts: MdPart[];
}

function parts(text: string): MdPart[] {
  return text
    .split(/\*\*(.+?)\*\*/)
    .map((t, i) => ({ text: t, bold: i % 2 === 1 }))
    .filter((p) => p.text);
}

export function mdBlocks(text: string): MdBlock[] {
  const out: MdBlock[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    const item = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (heading) out.push({ kind: 'heading', depth: 0, parts: parts(heading[1]) });
    else if (item) out.push({ kind: 'item', depth: Math.floor(item[1].length / 2), parts: parts(item[2]) });
    else out.push({ kind: 'para', depth: 0, parts: parts(line.trim()) });
  }
  return out;
}

// ------------------------------------------------------------------- an agent's reply, inline

/** A run of a reply's text in one style. It is shown as a text node inside <strong> or <em>, never
 *  as HTML, so whatever the text holds (a tag, a script) stays text. */
export interface InlinePart {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** How each character of a reply shows: hidden (a Markdown marker), replaced (a list bullet), and
 *  its style. Worked out on the whole passage, so a highlight that cuts through **bold** text still
 *  shows it bold on both sides. */
export interface InlineStyles {
  hidden: boolean[];
  bold: boolean[];
  italic: boolean[];
  replace: Map<number, string>;
}

const BOLD = [/(?<![*\\])\*\*(?=\S)([^\n]+?)(?<=\S)\*\*(?!\*)/g, /(?<![\w\\])__(?=\S)([^\n]+?)(?<=\S)__(?!\w)/g];
const ITALIC = [/(?<![*\w\\])\*(?=[^\s*])([^\n*]+?)(?<=[^\s*])\*(?![*\w])/g, /(?<![\w\\])_(?=[^\s_])([^\n_]+?)(?<=[^\s_])_(?!\w)/g];

/**
 * The small Markdown subset a model writes in a reply: **bold** and __bold__, *italics* and
 * _italics_, "- " and "* " bullets (shown as •), "#" headings (shown bold, without the hashes).
 * Numbered lists and line breaks show as written (the bubble keeps line breaks). Underscores
 * inside a word (mcp__finance__list_debts, max_tokens) and a lone * (5 * 3) are left as they are.
 */
export function inlineStyles(text: string): InlineStyles {
  const n = text.length;
  const hidden: boolean[] = Array(n).fill(false);
  const bold: boolean[] = Array(n).fill(false);
  const italic: boolean[] = Array(n).fill(false);
  const replace = new Map<number, string>();
  const mark = (re: RegExp, width: number, style: boolean[]) => {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      const end = at + m[0].length;
      // A marker already used by a wider match (a bold pair) is not an italic one too.
      if (hidden[at] || hidden[end - 1]) continue;
      for (let i = at; i < at + width; i++) hidden[i] = true;
      for (let i = end - width; i < end; i++) hidden[i] = true;
      for (let i = at + width; i < end - width; i++) style[i] = true;
    }
  };
  for (const re of BOLD) mark(re, 2, bold);
  for (const re of ITALIC) mark(re, 1, italic);
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const heading = /^(\s*)#{1,6}\s+/.exec(line);
    const bullet = /^(\s*)[-*+]\s+/.exec(line);
    if (heading) {
      for (let i = lineStart + heading[1].length; i < lineStart + heading[0].length; i++) hidden[i] = true;
      for (let i = lineStart + heading[0].length; i < lineStart + line.length; i++) bold[i] = true;
    } else if (bullet && !hidden[lineStart + bullet[1].length]) {
      replace.set(lineStart + bullet[1].length, '•');
    }
    lineStart += line.length + 1;
  }
  return { hidden, bold, italic, replace };
}

/** The parts of text[start, end) as shown: markers dropped, bullets replaced, runs of one style
 *  joined. */
export function inlineParts(text: string, styles: InlineStyles, start = 0, end = text.length): InlinePart[] {
  const out: InlinePart[] = [];
  for (let i = start; i < end; i++) {
    if (styles.hidden[i]) continue;
    const ch = styles.replace.get(i) ?? text[i];
    const b = styles.bold[i];
    const it = styles.italic[i];
    const last = out[out.length - 1];
    if (last && last.bold === b && last.italic === it) last.text += ch;
    else out.push({ text: ch, bold: b, italic: it });
  }
  return out;
}

/** A whole passage's parts, for text with no highlights in it. */
export function replyParts(text: string): InlinePart[] {
  return inlineParts(text, inlineStyles(text));
}
