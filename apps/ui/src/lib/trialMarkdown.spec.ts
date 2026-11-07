import { describe, expect, it } from 'vitest';
import type { AmountCheck } from './grading';
import { findQuote, messageBlocks, piecesOf, quoteText, stylesOf, type Mark, type MessageBlock, type QuoteMark, type Span } from './trialMarkdown';

/** The live reply on t_0mw38a1yn845728704a225ae4 (7 Nov) with its table, cut after the table. */
const REPLY = [
  "With an extra ₹2,000 a month, you'd finish 3 months early and save ₹3,558.27 in interest.",
  '',
  '| Extra per month | Total monthly payment | Months to close | Interest paid | Interest saved |',
  '|---|---|---|---|---|',
  '| None | ₹7,488.62 | 17 | ₹15,668.78 | — |',
  '| ₹3,000 | ₹10,488.62 | 12 | ₹10,917.46 | ₹4,751.32 |',
  '',
  'Each extra rupee goes straight to the loan.',
].join('\n');

const words = (text: string, b: MessageBlock) =>
  b.kind === 'para' ? text.slice(b.start, b.end) : b.kind === 'rule' ? '---' : [b.head, ...b.rows].map((r) => r.map((c) => text.slice(c.start, c.end)));

describe('messageBlocks', () => {
  it('reads a GitHub table as its header and rows, each cell a range of the reply, between its paragraphs', () => {
    const blocks = messageBlocks(REPLY);
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'table', 'para']);
    expect(words(REPLY, blocks[1])).toEqual([
      ['Extra per month', 'Total monthly payment', 'Months to close', 'Interest paid', 'Interest saved'],
      ['None', '₹7,488.62', '17', '₹15,668.78', '—'],
      ['₹3,000', '₹10,488.62', '12', '₹10,917.46', '₹4,751.32'],
    ]);
    expect(words(REPLY, blocks[2])).toBe('Each extra rupee goes straight to the loan.');
  });

  it('reads a table without outer pipes, its alignment, a short row, and a table straight under a line of text', () => {
    const text = 'Plan:\nMonth | Paid\n:--- | ---:\nJan | ₹500\nFeb';
    const blocks = messageBlocks(text);
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'table', 'para']);
    const table = blocks[1];
    if (table.kind !== 'table') throw new Error('no table');
    expect(table.align).toEqual(['left', 'right']);
    expect(words(text, table)).toEqual([
      ['Month', 'Paid'],
      ['Jan', '₹500'],
    ]);
    // "Feb" has no pipe: the table ends before it.
    expect(words(text, blocks[2])).toBe('Feb');
    // A short row is padded with empty cells, so its columns line up.
    expect(words('| a | b |\n|---|---|\n| 1 |', messageBlocks('| a | b |\n|---|---|\n| 1 |')[0])).toEqual([['a', 'b'], ['1', '']]);
  });

  it('keeps pipes that make no table as text, and reads a line of dashes alone as a rule', () => {
    const text = 'Pay ₹500 | or ₹600\n\n---\n\n- a bullet\n- another';
    expect(messageBlocks(text).map((b) => words(text, b))).toEqual(['Pay ₹500 | or ₹600', '---', '- a bullet\n- another']);
    // A client's message is paragraphs alone.
    expect(messageBlocks('| a | b |\n|---|---|\n| 1 | 2 |', false).map((b) => b.kind)).toEqual(['para']);
  });
});

describe('piecesOf', () => {
  it('cuts a quote that spans a table row at each cell, and only its first piece speaks', () => {
    const at = findQuote(REPLY, '| ₹3,000 | ₹10,488.62 | 12 | ₹10,917.46 | ₹4,751.32 |') as Span;
    expect(at).not.toBeNull();
    const quotes: Mark<QuoteMark>[] = [{ ...at, value: { index: 3, by: 'number check months-with-extra (failed)' } }];
    const table = messageBlocks(REPLY)[1];
    if (table.kind !== 'table') throw new Error('no table');
    const started = new Set<object>();
    const row = table.rows[1].map((cell) => piecesOf(REPLY, cell, stylesOf(REPLY, cell), quotes, [], started));
    expect(row.map((cell) => cell.map((p) => [p.text, p.quote?.index ?? null, p.quoteFirst]))).toEqual([
      [['₹3,000', 3, true]],
      [['₹10,488.62', 3, false]],
      [['12', 3, false]],
      [['₹10,917.46', 3, false]],
      [['₹4,751.32', 3, false]],
    ]);
  });

  it('marks an amount inside a quote as both, and keeps bold text bold across a highlight', () => {
    const text = '**Pay ₹5,500 now** and keep the rest.';
    const amount: AmountCheck = { text: '₹5,500', supported: false, source: null, start: null, end: null, note: null };
    const quote = findQuote(text, 'Pay ₹5,500 now') as Span;
    const span = { start: 0, end: text.length };
    const pieces = piecesOf(text, span, stylesOf(text, span), [{ ...quote, value: { index: 0, by: 'q' } }], [{ start: 6, end: 12, value: amount }], new Set());
    expect(pieces.map((p) => [p.parts.map((x) => `${x.bold ? 'b:' : ''}${x.text}`).join(''), !!p.quote, !!p.amount])).toEqual([
      ['b:Pay ', true, false],
      ['b:₹5,500', true, true],
      ['b: now', true, false],
      [' and keep the rest.', false, false],
    ]);
  });

  it('finds a quote whatever its whitespace, as the judge grader does', () => {
    expect(findQuote('Before you decide, please send:\n1. Loan amount', 'please send: 1. Loan')).toEqual({ start: 19, end: 39 });
    expect(findQuote('nothing here', 'not in it')).toBeNull();
    expect(findQuote('a (b) [c]', '(b) [c]')).toEqual({ start: 2, end: 9 });
  });
});

describe('quoteText', () => {
  it("drops a quote's Markdown markers and keeps its words", () => {
    // Live quotes from the judge and number check months-with-extra on t_0mw38a1yn845728704a225ae4 (7 Nov).
    expect(quoteText('- **Remaining interest:** ₹15,668.79. This is the part you can still avoid by paying the loan off early.')).toBe(
      'Remaining interest: ₹15,668.79. This is the part you can still avoid by paying the loan off early.',
    );
    expect(quoteText('| ₹3,000 | ₹10,488.62 | 12 | ₹10,917.46 | ₹4,751.32 |')).toBe('₹3,000 | ₹10,488.62 | 12 | ₹10,917.46 | ₹4,751.32');
    expect(quoteText('To tell you, I need:\n\n1. **The interest rate** on the offer.\n### Next\n* _tenure_ in months')).toBe(
      'To tell you, I need:\n\n1. The interest rate on the offer.\nNext\ntenure in months',
    );
    // Underscores inside a name and a lone asterisk stay.
    expect(quoteText('call mcp__finance__list_debts, 5 * 3')).toBe('call mcp__finance__list_debts, 5 * 3');
  });
});
