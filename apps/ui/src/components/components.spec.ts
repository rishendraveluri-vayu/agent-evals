import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import IntervalStrip from './IntervalStrip.vue';
import VerdictTag from './VerdictTag.vue';

const strip = (rows: InstanceType<typeof IntervalStrip>['$props']['rows']) =>
  mount(IntervalStrip, {
    props: { min: -20, max: 30, ticks: [{ value: 0, label: '0', strong: true }], rows, reference: { value: 0, dashed: true }, summary: 'test' },
  });

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
});

describe('VerdictTag', () => {
  it('tints better and worse with an arrow, and leaves no clear difference as plain text', () => {
    const better = mount(VerdictTag, { props: { verdict: 'better' } });
    expect(better.text()).toBe('Better');
    expect(better.classes()).toContain('verdict-tag--better');
    expect(better.find('svg').exists()).toBe(true);
    const worse = mount(VerdictTag, { props: { verdict: 'worse' } });
    expect(worse.classes()).toContain('verdict-tag--worse');
    const none = mount(VerdictTag, { props: { verdict: 'none' } });
    expect(none.text()).toBe('No clear difference');
    expect(none.classes()).toEqual(['verdict-plain']);
    expect(none.find('svg').exists()).toBe(false);
    expect(mount(VerdictTag, { props: { verdict: 'pending' } }).text()).toBe('No interval yet');
    expect(mount(VerdictTag, { props: { verdict: 'none', label: 'No clear difference after correction' } }).text()).toBe('No clear difference after correction');
  });
});
