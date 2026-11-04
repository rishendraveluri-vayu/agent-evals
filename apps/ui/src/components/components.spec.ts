import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { ticksFor, type StripRow, type Tick } from '../lib/scale';
import { settle, useFixtures } from '../test/helpers';
import CompareView from '../views/CompareView.vue';
import ExperimentsView from '../views/ExperimentsView.vue';
import IntervalStrip from './IntervalStrip.vue';
import VerdictTag from './VerdictTag.vue';

type Rows = StripRow[];

/** Makes every IntervalStrip measure itself at `px` wide, as a ResizeObserver in a browser would. */
function atWidth(px: number) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: (entries: { contentRect: { width: number } }[]) => void) {}
      observe() {
        this.cb([{ contentRect: { width: px } }]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

const strip = (rows: Rows, ticks: Tick[] = [{ value: 0, label: '0', strong: true }]) =>
  mount(IntervalStrip, {
    props: { min: -20, max: 30, ticks, rows, reference: { value: 0, dashed: true }, summary: 'test' },
  });

/** Where a row label sits, from its x, its anchor and the strip's estimate of 6.6 px a letter. */
function span(w: VueWrapper, label: string): [number, number] {
  const t = w.findAll('[data-test="strip-label"]').find((x) => x.text() === label);
  if (!t) throw new Error(`no label ${label}`);
  const x = Number(t.attributes('x'));
  const width = label.length * 6.6;
  return t.attributes('text-anchor') === 'end' ? [x - width, x] : [x, x + width];
}

const refX = (w: VueWrapper) => Number(w.get('line.ref').attributes('x1'));

describe('IntervalStrip', () => {
  it('labels a row beside its interval when there is room', () => {
    const w = strip([{ estimate: 1, low: -7, high: 9, tone: 'neutral', size: 'sm', label: 'A/A run' }]);
    expect(w.findAll('[data-test="strip-label"]').map((t) => t.text())).toEqual(['A/A run']);
    expect(w.find('[data-test="strip-legend"]').exists()).toBe(false);
  });

  it('names a row in a legend under the figure when its label has no room, so no row is unlabelled', () => {
    // Spans the whole axis at the default 600 px: neither side has room for the label.
    const long = 'A label far too long to fit on either side of this interval, whatever the width';
    const w = strip([
      { estimate: 5, low: -20, high: 30, tone: 'b', label: long },
      { estimate: 1, low: -7, high: 9, tone: 'neutral', size: 'sm', label: 'A/A run' },
    ]);
    expect(w.findAll('[data-test="strip-label"]').map((t) => t.text())).toEqual(['A/A run']);
    const legend = w.findAll('[data-test="strip-legend"] li');
    expect(legend.map((l) => l.text())).toEqual([long]);
    expect(legend[0].get('.swatch-line').classes()).toContain('swatch-line--b');
  });

  it('draws a main row larger than a small one, about 12 px apart edge to edge', () => {
    const w = strip([
      { estimate: 15, low: 7, high: 23, tone: 'b' },
      { estimate: 1, low: -7, high: 9, tone: 'neutral', size: 'sm' },
    ]);
    const [main, aa] = w.findAll('circle');
    expect(Number(main.attributes('r'))).toBe(10);
    expect(Number(aa.attributes('r'))).toBe(6);
    const gap = Number(aa.attributes('cy')) - Number(main.attributes('cy')) - (10 + 1.5) - (6 + 1);
    expect(gap).toBe(12);
  });

  it('puts a label above its row rather than across the zero line, and moves the rows down for it', () => {
    // At 600 px there is no room on the right, and on the left the label would cross zero.
    const label = 'v2 minus v1, 12 tasks';
    const w = strip([
      { estimate: 15, low: 7, high: 23, tone: 'b', label },
      { estimate: 1, low: -7, high: 9, tone: 'neutral', size: 'sm', label: 'A/A run' },
    ]);
    const text = w.findAll('[data-test="strip-label"]').find((t) => t.text() === label);
    expect(text?.attributes('data-place')).toBe('above');
    const [from, to] = span(w, label);
    const zero = refX(w);
    expect(zero < from - 6 || zero > to + 6).toBe(true);
    // Left-aligned with the interval's low end, above the dot.
    const [main, aa] = w.findAll('circle');
    expect(from).toBeCloseTo(Number(w.findAll('line.range')[0].attributes('x1')));
    expect(Number(text?.attributes('y'))).toBeLessThan(Number(main.attributes('cy')) - 10);
    expect(Number(main.attributes('cy'))).toBe(22 + 16);
    expect(Number(aa.attributes('cy')) - Number(main.attributes('cy'))).toBe(11.5 + 12 + 7);
  });

  it('never lets a row label touch the reference line, whatever the width', async () => {
    const rows: Rows = [
      { estimate: 15, low: 7, high: 23, tone: 'b', label: 'v2 minus v1, 12 tasks' },
      { estimate: 1, low: -7, high: 9, tone: 'neutral', size: 'sm', label: 'A/A run, same config twice' },
    ];
    for (const px of [320, 390, 600, 760, 900]) {
      atWidth(px);
      const w = strip(rows);
      await nextTick();
      const placed = w.findAll('[data-test="strip-label"]').map((t) => t.text());
      const legend = w.findAll('[data-test="strip-legend"] li').map((l) => l.text());
      expect([...placed, ...legend].sort()).toEqual(rows.map((r) => r.label).sort());
      for (const label of placed) {
        const [from, to] = span(w, label);
        expect(refX(w) < from - 6 || refX(w) > to + 6, `${label} at ${px} px`).toBe(true);
        expect(from).toBeGreaterThanOrEqual(20);
        expect(to).toBeLessThanOrEqual(px - 20);
      }
      w.unmount();
    }
  });

  it('keeps the shown ticks evenly spaced on a narrow figure, with zero in its short form', async () => {
    atWidth(320);
    const w = strip([{ estimate: 15, low: 7, high: 23, tone: 'b' }], ticksFor(-20, 30, 10));
    await nextTick();
    const ticks = w.findAll('[data-test="strip-tick"]');
    expect(ticks.map((t) => t.text())).toEqual(['−20', '0', '+20']);
    const xs = ticks.map((t) => Number(t.attributes('x')));
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1]);
    expect(ticks.every((t) => t.attributes('text-anchor') === 'middle')).toBe(true);
  });

  it('shows every tick, in full, when they all fit', () => {
    const w = strip([{ estimate: 15, low: 7, high: 23, tone: 'b' }], ticksFor(-20, 30, 10));
    expect(w.findAll('[data-test="strip-tick"]').map((t) => t.text())).toEqual(['−20', '−10', '0, no change', '+10', '+20', '+30']);
  });
});

describe('the two heroes', () => {
  useFixtures();

  it('pass the same tick labels to the strip on the main page and on Compare', async () => {
    const main = mount(ExperimentsView);
    const compare = mount(CompareView, { props: { experimentId: 'exp_heldout' } });
    await settle();
    const labels = (w: VueWrapper) => (w.findComponent(IntervalStrip).props('ticks') as Tick[]).map((t) => t.label);
    expect(labels(main)).toEqual(['−20', '−10', '0, no change', '+10', '+20', '+30']);
    expect(labels(compare)).toEqual(labels(main));
  });
});

describe('VerdictTag', () => {
  it('tints better and worse with an arrow, and leaves no clear difference as plain text', () => {
    const better = mount(VerdictTag, { props: { verdict: 'better' } });
    expect(better.text()).toBe('Better');
    expect(better.classes()).toContain('verdict-tag--better');
    expect(better.find('svg').exists()).toBe(true);
    const worse = mount(VerdictTag, { props: { verdict: 'worse' } });
    expect(worse.classes()).toContain('verdict-tag--worse');
    expect(better.attributes('data-verdict')).toBe('better');
    expect(worse.attributes('data-verdict')).toBe('worse');
    expect(worse.find('svg').exists()).toBe(true);
    const none = mount(VerdictTag, { props: { verdict: 'none' } });
    expect(none.text()).toBe('No clear difference');
    expect(none.classes()).toEqual(['result-plain']);
    // theme.css sets this one in regular weight: the absence of evidence, lighter than a finding.
    expect(none.attributes('data-verdict')).toBe('none');
    expect(none.find('svg').exists()).toBe(false);
    const pending = mount(VerdictTag, { props: { verdict: 'pending' } });
    expect(pending.text()).toBe('No interval yet');
    expect(pending.classes()).toEqual(['result-plain']);
    expect(pending.attributes('data-verdict')).toBe('pending');
    expect(mount(VerdictTag, { props: { verdict: 'none', label: 'No clear difference after correction' } }).text()).toBe('No clear difference after correction');
  });
});
