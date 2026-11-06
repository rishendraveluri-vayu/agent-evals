// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
const SRC = fileURLToPath(new URL('.', import.meta.url));

/** The tokens one theme block declares: a hex value or `var(--other)`, unresolved. */
function declared(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6}|var\(--[a-z0-9-]+\))/g)].map((m) => [m[1], m[2]]));
}

/** Every token as hex, following `var(--other)` within the same theme. */
function resolve(raw: Record<string, string>): Record<string, string> {
  const hex = (name: string, seen: string[] = []): string | undefined => {
    const v = raw[name];
    const ref = v?.match(/^var\(--([a-z0-9-]+)\)$/);
    if (!ref) return v;
    if (seen.includes(name)) return undefined;
    return hex(ref[1], [...seen, name]);
  };
  const out: Record<string, string> = {};
  for (const name of Object.keys(raw)) {
    const v = hex(name);
    if (v) out[name] = v;
  }
  return out;
}

/** The hex tokens of one theme block, as declared there. */
function tokens(selector: string): Record<string, string> {
  return Object.fromEntries(Object.entries(declared(selector)).filter(([, v]) => v.startsWith('#')));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = resolve(declared(':root'));
const dark = resolve({ ...declared(':root'), ...declared(":root[data-theme='dark']") });

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
  ['error', 'surface'],
  ['error', 'ground'],
  ['on-pass', 'pass'],
  ['arm-a-ink', 'arm-a-soft'],
  ['arm-b-ink', 'arm-b-soft'],
  ['ink', 'arm-a-soft'],
  ['ink', 'arm-b-soft'],
  ['client', 'surface-muted'],
  ['ink', 'mark'],
];

/** Marks and control edges against the surface: 3:1 (WCAG non-text contrast). */
const MARKS: [string, string][] = [
  ['arm-a', 'surface'],
  ['arm-b', 'surface'],
  ['pass', 'surface'],
  ['rule-strong', 'surface'],
  ['span-agent', 'surface'],
  // Tool bars, and the edge that keeps the light harness bars visible in both themes.
  ['neutral-mark-strong', 'surface'],
  // Grey intervals (no clear difference) and the hero's A/A row.
  ['neutral-line', 'surface'],
  ['focus', 'surface'],
  ['focus', 'ground'],
  ['on-pass', 'fail'],
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

describe('colour that carries meaning', () => {
  it('keeps blue for arm A: links and focus rings are ink in both themes', () => {
    for (const t of [light, dark]) {
      expect(t.link).toBe(t.ink);
      expect(t['link-hover']).toBe(t.ink);
      expect(t.focus).toBe(t.ink);
      expect(t.link).not.toBe(t['arm-a']);
    }
  });
});

describe('the trial page palette', () => {
  it('uses only the approved hues: no teal or violet tokens for tools or the client', () => {
    // The retired teal and violet tokens, spelt in parts so a search of the source finds none.
    const retired = [['span', 'tool'], ['span', 'client'], ['client', 'soft']].map((p) => `--${p.join('-')}`);
    for (const { file, css: sheet } of stylesheets()) {
      for (const name of retired) expect(sheet.includes(name), `${file} uses ${name}`).toBe(false);
    }
    for (const t of [light, dark]) expect(t.client).toBe(t['ink-2']);
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

/** Every stylesheet in the UI: theme.css and each component's <style> blocks, by file. */
function stylesheets(): { file: string; css: string }[] {
  const out: { file: string; css: string }[] = [{ file: 'theme.css', css }];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.vue')) {
        const source = readFileSync(path, 'utf8');
        const styles = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
        if (styles) out.push({ file: relative(SRC, path), css: styles });
      }
    }
  };
  walk(SRC);
  return out;
}

/** Each rule's selector and body, with comments and @media wrappers set aside. */
function rules(sheet: string): { selector: string; body: string }[] {
  const plain = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
}

/** Where pass green and fail red may appear: graded outcomes only. Anything else (an error, a
 *  probe, a saved config, a matrix of agreement) uses ink, greys or --error. */
const PASS_FAIL_ALLOWED: Record<string, string[]> = {
  // Grade pills.
  'theme.css': ['.pill--pass', '.pill--fail', ":root[data-theme='dark'] mark"],
  // The check badges before a run and in a trial.
  'components/AppIcon.vue': ['.badge-fill--pass', '.badge-fill--fail', '.badge-mark--pass', '.badge-mark--fail'],
  'components/VerdictTag.vue': ['.verdict-tag--better', '.verdict-tag--worse'],
  // Run grid cells.
  'views/RunView.vue': ['.cell--pass', '.cell--fail'],
  // Your own grade: Yes and No once pressed.
  'views/LabelView.vue': [".answer--yes[aria-pressed='true']", ".answer--no[aria-pressed='true']"],
};

describe('pass green and fail red', () => {
  it('appear only on graded outcomes: grade pills and badges, run-grid cells, VerdictTag, the quoted text on a trial', () => {
    const found: string[] = [];
    const allowed: string[] = [];
    for (const { file, css: sheet } of stylesheets()) {
      for (const { selector, body } of rules(sheet)) {
        if (selector === ':root' || selector === ":root[data-theme='dark']") continue; // token definitions
        if (!/var\(--(pass|pass-soft|fail|fail-soft)\)/.test(body)) continue;
        if ((PASS_FAIL_ALLOWED[file] ?? []).includes(selector)) allowed.push(`${file}: ${selector}`);
        else found.push(`${file}: ${selector}`);
      }
    }
    expect(found).toEqual([]);
    // The scan really reads every file: each allowed use is found where the list says.
    expect(allowed.sort()).toEqual(Object.entries(PASS_FAIL_ALLOWED).flatMap(([file, list]) => list.map((sel) => `${file}: ${sel}`)).sort());
  });

  it('are never reached through another name, except --error for error messages', () => {
    const aliases = rules(css)
      .filter((r) => r.selector.startsWith(':root'))
      .flatMap((r) => [...r.body.matchAll(/--([a-z0-9-]+):\s*var\(--(pass|pass-soft|fail|fail-soft)\)/g)].map((m) => m[1]));
    expect(aliases).toEqual(['error']);
  });
});

/** Every source file but the tests, with any <style> blocks taken out: the markup and scripts. */
function markup(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.vue') || (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))) {
        out.push({ file: relative(SRC, path), text: readFileSync(path, 'utf8').replace(/<style[^>]*>[\s\S]*?<\/style>/g, '') });
      }
    }
  };
  walk(SRC);
  return out;
}

/** Where a dashed stroke may appear: a zero line or infra, nothing else, so a dash always means
 *  one of those two. Solid lines carry every other mark, such as the spending cap. */
const DASH_ALLOWED: Record<string, string[]> = {
  // The task plot's zero line, under its axis label.
  'views/CompareView.vue': ['.zero-stub'],
  // The heroes' zero reference.
  'components/IntervalStrip.vue': ['.ref--dashed'],
};
/** Dashes drawn in markup rather than CSS: the infra badge's ring. */
const DASH_IN_MARKUP: Record<string, number> = { 'components/AppIcon.vue': 1 };

describe('dashed strokes', () => {
  it('appear only on zero lines and infra marks', () => {
    const found: string[] = [];
    const allowed: string[] = [];
    for (const { file, css: sheet } of stylesheets()) {
      for (const { selector, body } of rules(sheet)) {
        if (!/dasharray/.test(body)) continue;
        if ((DASH_ALLOWED[file] ?? []).includes(selector)) allowed.push(`${file}: ${selector}`);
        else found.push(`${file}: ${selector}`);
      }
    }
    expect(found).toEqual([]);
    expect(allowed.sort()).toEqual(Object.entries(DASH_ALLOWED).flatMap(([file, list]) => list.map((sel) => `${file}: ${sel}`)).sort());
    const inMarkup = Object.fromEntries(markup().map(({ file, text }) => [file, (text.match(/dasharray/g) ?? []).length] as const).filter(([, n]) => n > 0));
    expect(inMarkup).toEqual(DASH_IN_MARKUP);
  });
});

describe('results that are not findings', () => {
  it('sets no clear difference in regular weight, while status words and pills keep theirs', () => {
    const all = rules(css);
    const plain = all.find((r) => r.selector === '.result-plain');
    const none = all.find((r) => r.selector === ".result-plain[data-verdict='none']");
    expect(plain?.body).toMatch(/font-weight:\s*500/);
    expect(plain?.body).toMatch(/font-size:\s*14px/);
    expect(none?.body.trim()).toBe('font-weight: 400;');
  });
});

describe('disclosures', () => {
  it('show a chevron that flips when open, on every kind of summary', () => {
    const all = rules(css);
    const chevron = all.find((r) => r.selector.includes('summary::after') && !r.selector.includes('[open]'));
    const flipped = all.find((r) => r.selector.includes('[open] > summary::after'));
    for (const kind of ['.disclosure', '.options', '.requests', '.run-details']) {
      expect(chevron?.selector, kind).toContain(`${kind} > summary::after`);
      expect(flipped?.selector, kind).toContain(`${kind}[open] > summary::after`);
    }
    expect(chevron?.body).toMatch(/margin-left:\s*auto/);
    expect(chevron?.body).toMatch(/flex:\s*none/);
    // The summary itself never wraps, so the chevron cannot drop to a line of its own.
    const summary = all.find((r) => r.selector.startsWith('.disclosure > summary, .options > summary'));
    expect(summary?.body).toMatch(/flex-wrap:\s*nowrap/);
    expect(chevron?.body).toMatch(/border-right:\s*2px solid var\(--ink-2\)/);
    expect(flipped?.body).toMatch(/rotate\(-135deg\)/);
  });
});

describe('focus', () => {
  it('shows no ring on a heading given focus when a screen opens, and keeps the ring on controls', () => {
    expect(css).toMatch(/h1\[tabindex='-1'\]:focus,\s*h2\[tabindex='-1'\]:focus \{\s*outline: none;/);
    expect(css).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--focus\);/);
  });

  // jsdom lays nothing out, so the width checks themselves are Playwright's (390 and 1440 px).
  it('never lets a select widen a phone page past its edge (destructive review U11)', () => {
    expect(css).toMatch(/\nselect \{\s*max-width: 100%;\s*min-width: 0;/);
  });

  it('wraps long names with no spaces in headings, text and the saved-configs list (destructive review U12)', () => {
    expect(css).toMatch(/h1,\s*h2,\s*h3 \{[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/body \{[^}]*overflow-wrap: break-word;/);
    const config = readFileSync(new URL('./views/ConfigView.vue', import.meta.url), 'utf8');
    expect(config).toMatch(/\.saved-list ul \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(config).toMatch(/\.saved-list li \{\s*min-width: 0;\s*overflow-wrap: anywhere;/);
  });
});
