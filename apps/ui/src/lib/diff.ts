/** Differences between two prompt versions: which lines changed, and within them, which
 *  sentences, so a reader sees the words that moved rather than two long near-identical lines. */
export interface LineChange {
  side: 'a' | 'b';
  text: string;
}

interface RunChange extends LineChange {
  run: number;
}

function changesByRun(a: string, b: string): RunChange[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: RunChange[] = [];
  let i = 0;
  let j = 0;
  let run = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      i++;
      j++;
      run++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push({ side: 'b', text: y[j++], run });
    } else {
      out.push({ side: 'a', text: x[i++], run });
    }
  }
  return out.filter((c) => c.text.trim() !== '');
}

/** Changed lines; within each run of changes, the old lines (A) come before their replacements (B). */
export function lineChanges(a: string, b: string): LineChange[] {
  return changesByRun(a, b)
    .sort((p, q) => p.run - q.run || (p.side === q.side ? 0 : p.side === 'a' ? -1 : 1))
    .map(({ side, text }) => ({ side, text }));
}

/** How many lines changed: a replaced line counts once. */
export function changedLineCount(changes: LineChange[]): number {
  const a = changes.filter((c) => c.side === 'a').length;
  const b = changes.filter((c) => c.side === 'b').length;
  return Math.max(a, b);
}

const sentences = (text: string) =>
  text
    .split(/(?<=[.!?:][*"”')]*)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The sentences each side has that the other does not, per run of changed lines. A sentence
 *  that only moved is not shown; a run where nothing was removed shows only its B line. */
export function sentenceChanges(a: string, b: string): LineChange[] {
  const runs = new Map<number, { a: string[]; b: string[] }>();
  for (const c of changesByRun(a, b)) {
    const r = runs.get(c.run) ?? { a: [], b: [] };
    r[c.side].push(c.text);
    runs.set(c.run, r);
  }
  const out: LineChange[] = [];
  for (const r of runs.values()) {
    const sa = sentences(r.a.join(' '));
    const sb = sentences(r.b.join(' '));
    const removed = sa.filter((s) => !sb.includes(s));
    const added = sb.filter((s) => !sa.includes(s));
    if (removed.length) out.push({ side: 'a', text: removed.join(' ') });
    if (added.length) out.push({ side: 'b', text: added.join(' ') });
  }
  return out;
}
