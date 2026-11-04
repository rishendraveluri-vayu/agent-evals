// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** The tokens of one theme block, as hex. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(':root');
const dark = { ...light, ...tokens(":root[data-theme='dark']") };

/** Text on its background: 4.5:1 (WCAG AA for body text). */
const TEXT: [string, string][] = [
  ['ink', 'ground'],
  ['ink', 'surface'],
  ['ink', 'surface-muted'],
  ['ink-2', 'ground'],
  ['ink-2', 'surface'],
  ['ink-2', 'surface-muted'],
  ['link', 'surface'],
  ['link', 'ground'],
  ['on-primary', 'primary'],
  ['pass', 'pass-soft'],
  ['pass', 'surface'],
  ['fail', 'fail-soft'],
  ['fail', 'fail-cell'],
  ['fail', 'surface'],
  ['on-pass', 'pass'],
  ['arm-a-ink', 'arm-a-soft'],
  ['arm-b-ink', 'arm-b-soft'],
  ['ink', 'arm-a-soft'],
  ['ink', 'arm-b-soft'],
  ['client', 'client-soft'],
  ['ink', 'client-soft'],
  ['ink', 'mark'],
];

/** Marks and control edges against the surface: 3:1 (WCAG non-text contrast). */
const MARKS: [string, string][] = [
  ['arm-a', 'surface'],
  ['arm-b', 'surface'],
  ['pass', 'surface'],
  ['rule-strong', 'surface'],
  ['span-agent', 'surface'],
  ['span-tool', 'surface'],
  ['span-client', 'surface'],
  ['focus', 'surface'],
  ['focus', 'ground'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('the %s theme', (_name, t) => {
  it.each(TEXT)('%s on %s reads at 4.5:1 or more', (fg, bg) => {
    expect(t[fg], fg).toBeDefined();
    expect(t[bg], bg).toBeDefined();
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MARKS)('%s on %s stands out at 3:1 or more', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });
});

describe('the dark theme', () => {
  it('has its own value for every colour token rather than flipping the light ones', () => {
    const own = tokens(":root[data-theme='dark']");
    for (const name of ['ground', 'surface', 'ink', 'ink-2', 'arm-a', 'arm-b', 'pass', 'fail', 'rule']) {
      expect(own[name], name).toBeDefined();
      expect(own[name]).not.toBe(light[name]);
    }
  });

  it('is only applied when chosen, never from the system setting', () => {
    expect(css).not.toContain('prefers-color-scheme');
  });
});
