import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { ticksFor, type StripRow, type Tick } from '../lib/scale';
import { settle, useFixtures } from '../test/helpers';
import CompareView from '../views/CompareView.vue';
import ExperimentsView from '../views/ExperimentsView.vue';
import AppHeader from './AppHeader.vue';
import IntervalStrip from './IntervalStrip.vue';
import LoadState from './LoadState.vue';
import SpanTimeline from './SpanTimeline.vue';
import VerdictTag from './VerdictTag.vue';
import type { SpanView } from '../trials';

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

  it('breaks the first row\'s axis track around a label beside it, so no line runs behind the words', () => {
    const label = 'κ 0.70, 40 labelled checks';
    const w = mount(IntervalStrip, {
      props: { min: 0, max: 1, ticks: [{ value: 0.6, label: 'bar 0.6', strong: true }], rows: [{ estimate: 0.7, low: 0.47, high: 0.88, tone: 'ink', label }], reference: { value: 0.6 }, summary: 'test' },
    });
    expect(w.get('[data-test="strip-label"]').attributes('data-place')).toBe('beside');
    const [from, to] = span(w, label);
    const segments = w.findAll('[data-test="strip-axis"]').map((l) => [Number(l.attributes('x1')), Number(l.attributes('x2'))]);
    expect(segments.length).toBeGreaterThan(0);
    for (const [x1, x2] of segments) expect(x2 <= from - 6 || x1 >= to + 6, `segment ${x1} to ${x2} crosses the label`).toBe(true);
    // The track still starts at the figure's left edge.
    expect(segments[0][0]).toBe(20);
  });

  it('keeps the axis track whole when the first row\'s label sits above it', () => {
    const w = strip([
      { estimate: 15, low: 7, high: 23, tone: 'b', label: 'v2 minus v1, 12 tasks' },
      { estimate: 1, low: -7, high: 9, tone: 'neutral', size: 'sm', label: 'A/A run' },
    ]);
    expect(w.findAll('[data-test="strip-label"]')[0].attributes('data-place')).toBe('above');
    const segments = w.findAll('[data-test="strip-axis"]').map((l) => [Number(l.attributes('x1')), Number(l.attributes('x2'))]);
    expect(segments).toEqual([[20, 580]]);
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

describe('SpanTimeline', () => {
  const span = (id: string, parent: string | null, name: string, start: number, end: number, attributes = {}): SpanView => ({
    spanId: id, parentSpanId: parent, name, kind: 1, startNs: String(start * 1_000_000), endNs: String(end * 1_000_000), statusCode: 1, statusMessage: null, attributes, events: [],
  });
  // A 24.6 s trial: 5.4 s of start-up, then the agent's work, then the shut-down.
  const spans = [
    span('t', null, 'invoke_agent hermes', 0, 24_600),
    span('u', 't', 'agent.turn', 5_400, 23_000),
    span('c', 'u', 'chat claude-haiku-5-5', 5_400, 9_000, { 'evals.role': 'agent', 'gen_ai.request.model': 'claude-haiku-5-5' }),
    span('d', 'u', 'execute_tool get_client_profile', 9_000, 9_400, { 'gen_ai.tool.name': 'get_client_profile' }),
    span('e', 'u', 'chat claude-haiku-5-5', 9_400, 23_000, { 'evals.role': 'agent', 'gen_ai.request.model': 'claude-haiku-5-5' }),
  ];
  const mountIt = () => mount(SpanTimeline, { props: { spans, selected: null, harness: 'hermes' } });
  const seconds = (label: string) => Number(label.replace(/ s$/, ''));

  it('snaps the axis out to the next tick, so its last label is at least the trial length', async () => {
    const w = mountIt();
    const labels = w.findAll('.axis-tick').map((t) => t.text());
    expect(labels).toEqual(['0 s', '5 s', '10 s', '15 s', '20 s', '25 s']);
    expect(seconds(labels[labels.length - 1])).toBeGreaterThanOrEqual(24.6);
    // The shut-down bar ends before the axis does.
    const shutdown = w.findAll('.row--static').find((r) => r.text().includes('Shut down'));
    const bar = shutdown?.get('.bar').attributes('style') ?? '';
    const [left, width] = [/left: ([\d.]+)%/, /width: ([\d.]+)%/].map((re) => Number(bar.match(re)?.[1]));
    expect(left + width).toBeLessThan(100);
    expect(left + width).toBeCloseTo((24.6 / 25) * 100);
    // Skipping start-up keeps the labels in trial time.
    await w.get('[data-test="skip-startup"]').setValue(true);
    const skipped = w.findAll('.axis-tick').map((t) => t.text());
    expect(seconds(skipped[skipped.length - 1])).toBeGreaterThanOrEqual(24.6);
  });

  it('keeps the key to swatches only, with the skip control apart from it', () => {
    const w = mountIt();
    const key = w.get('[data-test="timeline-key"]');
    expect(key.find('input').exists()).toBe(false);
    expect(key.findAll('.legend-item').map((i) => i.text())).toEqual(['Agent model call', 'Tool call', 'Simulated client', 'Harness overhead']);
    const skip = w.get('[data-test="skip-label"]');
    expect(skip.element.parentElement).toBe(key.element.parentElement);
    expect(skip.text()).toBe('Skip start-up\u00a0(5.4 s)');
  });

  it('sets the tool name in mono, keeping the plain name for the tooltip and screen readers', () => {
    const w = mountIt();
    const row = w.findAll('[data-test="span-row"]').find((r) => r.text().includes('get_client_profile'));
    expect(row?.get('.label').text()).toBe('tool get_client_profile');
    expect(row?.get('[data-test="span-ident"]').classes()).toContain('mono');
    expect(row?.get('.label').attributes('title')).toBe('tool get_client_profile');
    expect(row?.attributes('aria-label')).toBe('tool get_client_profile, 0.4 s. Show its details');
  });

  it("lets a long tool name wrap at its underscores instead of cutting it off, as Hermes's prefixed names need", () => {
    const long = [...spans.slice(0, 3), span('d', 'u', 'execute_tool mcp__finance__list_debts', 9_000, 9_400, { 'gen_ai.tool.name': 'mcp__finance__list_debts' }), spans[4]];
    const w = mount(SpanTimeline, { props: { spans: long, selected: null, harness: 'hermes' } });
    const row = w.findAll('[data-test="span-row"]').find((r) => r.text().includes('list_debts'));
    const label = row?.get('.label');
    // The whole name is there, with a break opportunity after each run of underscores.
    expect(label?.text()).toBe('tool mcp__finance__list_debts');
    expect(label?.classes()).toContain('label--wrap');
    expect(label?.findAll('wbr')).toHaveLength(3);
  });
});

describe('VerdictTag', () => {
  it('tints better and worse with an arrow, and leaves no detectable difference as plain text', () => {
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
    expect(none.text()).toBe('No detectable difference');
    expect(none.classes()).toEqual(['result-plain']);
    // theme.css sets this one in regular weight: the absence of evidence, lighter than a finding.
    expect(none.attributes('data-verdict')).toBe('none');
    expect(none.find('svg').exists()).toBe(false);
    const pending = mount(VerdictTag, { props: { verdict: 'pending' } });
    expect(pending.text()).toBe('No interval yet');
    expect(pending.classes()).toEqual(['result-plain']);
    expect(pending.attributes('data-verdict')).toBe('pending');
    expect(mount(VerdictTag, { props: { verdict: 'none', label: 'Within noise after correction' } }).text()).toBe('Within noise after correction');
  });
});

describe('AppHeader on a phone', () => {
  useFixtures();

  it('fades the nav at an edge that has sections out of sight, so it reads as a row that scrolls', async () => {
    const w = mount(AppHeader, { props: { section: 'experiments' } });
    await settle();
    const nav = w.get('[data-test="main-nav"]');
    const el = nav.element as HTMLElement;
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 390 });
    el.scrollLeft = 0;
    await nav.trigger('scroll');
    expect(nav.classes()).toContain('nav--more-right');
    expect(nav.classes()).not.toContain('nav--more-left');
    el.scrollLeft = 210;
    await nav.trigger('scroll');
    expect(nav.classes()).toContain('nav--more-left');
    expect(nav.classes()).not.toContain('nav--more-right');
    // The theme button keeps its name when it shows only its icon.
    expect(w.get('[data-test="theme-toggle"]').attributes('aria-label')).toBe('Dark theme');
    expect(w.get('[data-test="theme-toggle"]').attributes('title')).toBe('Dark theme');
  });
});

describe('LoadState (destructive review U8)', () => {
  it('offers to try again after a failed load, with the screen’s own reload', async () => {
    const retry = vi.fn(() => Promise.resolve());
    const w = mount(LoadState, { props: { loading: false, error: 'The API is not answering (HTTP 502): check that the stack is running (docker compose ps), then try again', what: 'the experiments', retry } });
    expect(w.get('[role="alert"]').text()).toBe('Could not load the experiments: The API is not answering (HTTP 502): check that the stack is running (docker compose ps), then try again');
    await w.get('[data-test="load-retry"]').trigger('click');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows no retry while loading or once loaded', () => {
    const loading = mount(LoadState, { props: { loading: true, error: null, what: 'the experiments' } });
    expect(loading.find('[data-test="load-retry"]').exists()).toBe(false);
    const done = mount(LoadState, { props: { loading: false, error: null, what: 'x' }, slots: { default: '<p data-test="body">ok</p>' } });
    expect(done.find('[data-test="load-retry"]').exists()).toBe(false);
    expect(done.find('[data-test="body"]').exists()).toBe(true);
  });
});
