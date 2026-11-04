import { describe, expect, it } from 'vitest';
import { normalizeSpan, toBlindItem } from '../api/client';
import type { Config } from '../api/types';
import { armsOf, headline, judgeCaveat, methodName, pointsWithInterval, setupOf, timeLeft } from './arms';
import { coverage, coverageText } from './capabilities';
import { armsCheck, axisFromDiff, budgetCheck, capabilityCheck, splitCheck } from './checks';
import { sentenceChanges } from './diff';
import { money, relative, shortHash, signed, wholeMoney } from './format';
import { mdBlocks } from './markdown';
import { modelName } from './names';
import { domainFor, ticksFor, verdictTone } from './scale';

const config = (over: Partial<Config>): Config => ({
  hash: 'sha256:3b81e04aaaa',
  name: 'c',
  harness: 'hermes',
  harness_ref: 'x',
  model: 'claude-haiku-5-5',
  prompt: { id: 'finance-advisor', version: 'v1', sha256: 'sha256:p1' },
  toolset: { id: 'finance/all', version: '1', sha256: 'sha256:t' },
  settings: {},
  settings_sources: {},
  harness_options: {},
  created_at: '2026-11-01T00:00:00Z',
  ...over,
});

describe('format', () => {
  it('writes signs with a real minus and money to the cent', () => {
    expect(signed(15)).toBe('+15');
    expect(signed(-40)).toBe('−40');
    expect(signed(0)).toBe('0');
    expect(money(18.4)).toBe('$18.40');
    expect(money(0.0021)).toBe('$0.0021');
    expect(wholeMoney(150)).toBe('$150');
    expect(shortHash('sha256:7f3a9c2deadbeef')).toBe('7f3a9c2');
  });

  it('gives relative times in words', () => {
    expect(relative(new Date(Date.now() - 2 * 3600_000).toISOString())).toBe('2 h ago');
    expect(relative(new Date(Date.now() - 30 * 3600_000).toISOString())).toBe('Yesterday');
  });

  it('names models the way people say them', () => {
    expect(modelName('claude-haiku-5-5')).toBe('Claude Haiku 5.5');
    expect(modelName('gemini-3.8-flash')).toBe('Gemini 3.8 Flash');
  });
});

describe('scale', () => {
  it('pads the range and snaps both ends outward to tens, keeping zero on the axis', () => {
    expect(domainFor([7, 23, -7, 9], -20, 30)).toEqual([-20, 30]);
    expect(domainFor([2, 31], -15, 25)).toEqual([-20, 40]);
    expect(domainFor([-43, 12], -20, 30)).toEqual([-50, 30]);
  });

  it('gives evenly spaced ticks every 10 points, zero named and no unit on any tick', () => {
    const ticks = ticksFor(-20, 30, 10);
    expect(ticks.map((t) => t.label)).toEqual(['−20', '−10', '0, no change', '+10', '+20', '+30']);
    expect(ticks.find((t) => t.value === 0)).toMatchObject({ short: '0', strong: true });
    expect(ticks.filter((t) => t.strong)).toHaveLength(1);
    expect(ticks.some((t) => t.label.includes('point'))).toBe(false);
    const values = ticks.map((t) => t.value);
    expect(new Set(values.slice(1).map((v, i) => v - values[i]))).toEqual(new Set([10]));
  });

  it('gives an arm colour only to a result that holds up', () => {
    expect(verdictTone('better')).toBe('b');
    expect(verdictTone('worse')).toBe('a');
    expect(verdictTone('no_clear_difference')).toBe('neutral');
  });
});

describe('sentenceChanges', () => {
  it('shows only the sentences that changed between two prompt versions', () => {
    const a = '- **Read.** People differ.\nSame line.\n- **Short.** Then steps. Stay under about 250 words unless asked.';
    const b = '- **Read.** If in distress, respond first. People differ.\nSame line.\n- **Short.** Then steps. Stay under about 200 words.';
    expect(sentenceChanges(a, b)).toEqual([
      { side: 'b', text: 'If in distress, respond first.' },
      { side: 'a', text: 'Stay under about 250 words unless asked.' },
      { side: 'b', text: 'Stay under about 200 words.' },
    ]);
  });
});

describe('markdown', () => {
  it('reads headings, bullets and bold, and nothing else', () => {
    expect(mdBlocks('## How\n- **Use tools.** Always.\n<b>x</b>')).toEqual([
      { kind: 'heading', depth: 0, parts: [{ text: 'How', bold: false }] },
      { kind: 'item', depth: 0, parts: [{ text: 'Use tools.', bold: true }, { text: ' Always.', bold: false }] },
      { kind: 'para', depth: 0, parts: [{ text: '<b>x</b>', bold: false }] },
    ]);
  });
});

describe('checks before a run', () => {
  it('finds the one thing two configs differ in', () => {
    expect(axisFromDiff([{ path: 'prompt.version', a: 'v1', b: 'v2' }, { path: 'prompt.sha256', a: 'x', b: 'y' }, { path: 'name', a: 'p', b: 'q' }], false)).toBe('prompt');
    expect(axisFromDiff([{ path: 'harness', a: 'ownloop', b: 'hermes' }, { path: 'settings.memory', a: null, b: false }], false)).toBe('harness');
    expect(axisFromDiff([{ path: 'model', a: 'a', b: 'b' }, { path: 'settings.temperature', a: 0.2, b: 0.7 }], false)).toBeNull();
    expect(armsCheck([{ path: 'model', a: 'a', b: 'b' }, { path: 'settings.temperature', a: 0.2, b: 0.7 }], false).ok).toBe(false);
  });

  it('fails when a config sets something its harness cannot apply', () => {
    const harness = {
      name: 'ownloop', package: 'ownloop', ref: '0.1.0', python: '3.11',
      capabilities: { settings: { memory: { supported: false, evidence: 'declared:no such feature' }, temperature: { supported: true, evidence: 'probe:2026-11-03' } } },
    } as unknown as Parameters<typeof capabilityCheck>[1][number];
    expect(capabilityCheck([config({ harness: 'ownloop', settings: { memory: true } })], [harness]).ok).toBe(false);
    expect(capabilityCheck([config({ harness: 'ownloop', settings: { temperature: 0.2 } })], [harness]).ok).toBe(true);
  });

  it('keeps held-out and discovery tasks apart and the budget above the likely cost', () => {
    const t = (split: string) => ({ sha256: split, id: split, version: '1', split, kind: 'single', summary: '', graders: [] });
    expect(splitCheck([t('heldout'), t('discovery')], []).ok).toBe(false);
    expect(splitCheck([t('heldout')], [t('discovery')]).title).toBe('1 held-out tasks, none of the discovery tasks');
    const estimate = { trials: 1, cost_usd: { expected: 20, low: 15, high: 27 }, minutes: 1, basis: '' };
    expect(budgetCheck(25, estimate).ok).toBe(false);
    expect(budgetCheck(40, estimate).ok).toBe(true);
  });
});

describe('arms', () => {
  it('names arms by the thing that changes and says what they share', () => {
    const configs = [config({}), config({ hash: 'sha256:7f3a9c2bbbb', prompt: { id: 'finance-advisor', version: 'v2', sha256: 'sha256:p2' } })];
    const exp = { axis: 'prompt', config_hashes: configs.map((c) => c.hash) };
    const arms = armsOf(exp, configs);
    expect(arms.map((a) => a.label)).toEqual(['Prompt v1', 'Prompt v2']);
    expect(setupOf(exp, arms)).toBe('Hermes with Claude Haiku 5.5');
    const stats = { verdict: 'better' } as Parameters<typeof headline>[0];
    expect(headline(stats, arms, [{ sha256: 'a', id: 'a', version: '1', split: 'heldout', kind: 'single', summary: '', graders: [] }])).toBe('Prompt v2 beats v1 on the held-out tasks');
    expect(armsOf({ axis: 'none', config_hashes: [configs[0].hash, configs[0].hash] }, configs).map((a) => a.label)).toEqual(['Config 3b81e04', 'Config 3b81e04']);
  });

  it('writes a difference in points, with its interval, and one point in the singular', () => {
    expect(pointsWithInterval({ estimate: 15, low: 7, high: 23 })).toBe('+15 points (+7 to +23)');
    expect(pointsWithInterval({ estimate: 1, low: -7, high: 9 })).toBe('+1 point (−7 to +9)');
    expect(pointsWithInterval({ estimate: -1, low: -9, high: 7 })).toBe('−1 point (−9 to +7)');
    expect(pointsWithInterval({ estimate: 0, low: -5, high: 5 })).toBe('0 points (−5 to +5)');
  });

  it('works out the time left from the estimate and the trials done', () => {
    expect(timeLeft({ minutes: 38 }, 60, 120)).toBe(19);
    expect(timeLeft({ minutes: 38 }, 120, 120)).toBe(0);
    expect(timeLeft(null, 60, 120)).toBeNull();
  });

  it('names only the methods the statistics step names', () => {
    expect(methodName('paired_task_bootstrap')).toBe('Paired task bootstrap');
    expect(methodName('something_new')).toBe('something_new');
  });
});

describe('judgeCaveat', () => {
  const judged = { id: 'a', judged: true };
  const code = { id: 'b', judged: false };
  const judge = { kappa: 0.7, low: 0.47, high: 0.88, bar: 0.6, tasks: 4 };
  const isJudged = (t: { judged: boolean }) => t.judged;

  it('says the result rests on the judge when every differing task is judge-graded', () => {
    const c = judgeCaveat({ differing: [judged, { ...judged, id: 'c' }], isJudged, judge, toGo: 3 });
    expect(c?.text).toBe(
      'Rests on the judge: both tasks that differ are judge-graded, and its agreement with you (κ 0.70, interval 0.47 to 0.88) dips below the 0.6 bar and is provisional.',
    );
    expect(c?.link).toBe('agreement with you');
    expect(`${c?.before}${c?.link}${c?.after}`).toBe(c?.text);
    expect(judgeCaveat({ differing: [judged], isJudged, judge, toGo: 0 })?.text).toBe(
      'Rests on the judge: the one task that differs is judge-graded, and its agreement with you (κ 0.70, interval 0.47 to 0.88) dips below the 0.6 bar.',
    );
    expect(judgeCaveat({ differing: [judged, judged, judged], isJudged, judge, toGo: 1 })?.text).toContain('all 3 tasks that differ are judge-graded');
  });

  it('says nothing when a code grader also sees a differing task, or there is no judge or no difference', () => {
    expect(judgeCaveat({ differing: [judged, code], isJudged, judge, toGo: 3 })).toBeNull();
    expect(judgeCaveat({ differing: [judged], isJudged, judge: null, toGo: 3 })).toBeNull();
    expect(judgeCaveat({ differing: [], isJudged, judge, toGo: 3 })).toBeNull();
  });

  it('says the judge clears the bar when its whole interval does and labelling is done', () => {
    expect(judgeCaveat({ differing: [judged], isJudged, judge: { ...judge, low: 0.62 }, toGo: 0 })?.text).toBe(
      'Rests on the judge: the one task that differs is judge-graded, and its agreement with you (κ 0.70, interval 0.62 to 0.88) clears the 0.6 bar.',
    );
    expect(judgeCaveat({ differing: [judged], isJudged, judge: { ...judge, low: 0.62 }, toGo: 2 })?.after).toContain(') is provisional.');
  });
});

describe('capability coverage', () => {
  const harness = (evidence: string[]) =>
    ({ capabilities: { settings: Object.fromEntries(evidence.map((e, i) => [`s${i}`, { supported: true, evidence: e }])) } }) as unknown as Parameters<typeof coverage>[0];

  it('counts probed, declared and pending settings, and names only the nonzero parts', () => {
    const h = harness(['probe:2026-11-03', 'probe:2026-11-03', 'declared:adapter watchdog', 'none']);
    expect(coverage(h)).toEqual({ probed: 2, declared: 1, pending: 1, total: 4 });
    expect(coverageText(h)).toBe('2 probed, 1 declared, 1 not probed yet');
    expect(coverageText(harness(['declared:x', 'none', 'none']))).toBe('1 declared, 2 not probed yet');
    expect(coverageText(harness(['probe:x', 'declared:y']))).toBe('1 probed, 1 declared');
  });
});

describe('client', () => {
  it('reads contract v2 OTLP spans and the folder store spans alike', () => {
    const otlp = normalizeSpan({
      traceId: 't', spanId: 'a1', parentSpanId: '', name: 'execute_tool x', kind: 1, startTimeUnixNano: '10', endTimeUnixNano: '20',
      attributes: [{ key: 'evals.tool.is_error', value: { boolValue: true } }, { key: 'n', value: { intValue: '3' } }], status: { code: 2, message: 'boom' },
    });
    expect(otlp).toMatchObject({ spanId: 'a1', parentSpanId: null, startNs: '10', statusCode: 2, statusMessage: 'boom', attributes: { 'evals.tool.is_error': true, n: 3 } });
    const flat = { spanId: 'b', parentSpanId: null, name: 'n', kind: 1, startNs: '1', endNs: '2', statusCode: 1, statusMessage: null, attributes: {}, events: [] };
    expect(normalizeSpan(flat)).toEqual(flat);
  });

  it('keeps only the blind fields of a labelling item', () => {
    const item = toBlindItem({ item_id: 'i', task_summary: 's', transcript: [{ role: 'user', content: 'q', model: 'x' }], tool_calls: [], criteria: ['c'], harness: 'hermes', cost_usd: 1, grade: 'fail' });
    expect(item).toEqual({ item_id: 'i', task_summary: 's', transcript: [{ role: 'user', content: 'q' }], tool_calls: [], criteria: ['c'] });
  });
});
