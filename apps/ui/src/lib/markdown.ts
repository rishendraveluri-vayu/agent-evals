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
