import { sha256Ref } from '../common/hashing';
import { OURS_MARKER, TRUNCATION_NOTE, harnessOwnText, renderFromRequest } from './rendered-prompt';

const OURS = 'You are a personal finance advisor for clients in India.\n\n- Stay under about 250 words.\n';
const PROBE = 'fake/finance-emi';

/** A first request shaped like Hermes's (harness guide 3.3), shortened: its text, ours, then its volatile tier. */
function hermesRequest(ours = OURS): Record<string, unknown> {
  const system =
    'You are Hermes Agent, built by Nous Research. Be direct: a one-line question gets a one-line answer.\n\n' +
    '# Parallel tool calls\nWhen in doubt and the calls are independent, batch them.\n\n' +
    ours +
    '\nActive Hermes profile: default.\n\n' +
    'Conversation started: Wednesday, November 04, 2026 (UTC, UTC+00:00)\n' +
    `Model: ${PROBE}\nProvider: custom\n`;
  return {
    model: PROBE,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'What is my EMI?' },
    ],
    tools: [{ type: 'function', function: { name: 'mcp__finance__calculate_emi', parameters: {} } }, { type: 'function', function: { name: 'mcp__finance__list_debts' } }],
    _headers_seen: ['content-type'],
  };
}

describe('renderFromRequest', () => {
  it('reads the system text, normalises the date and probe model, and marks our prompt', () => {
    const out = renderFromRequest(hermesRequest(), OURS, PROBE);
    if (!out.ok) throw new Error(out.error);
    const r = out.rendered;
    expect(r.system_text).toContain('Conversation started: <date>\nModel: <model>\nProvider: custom');
    expect(r.system_text).not.toContain('November');
    expect(r.system_text).not.toContain(PROBE);
    expect(r.ours).not.toBeNull();
    expect(r.system_text.slice(r.ours!.start, r.ours!.end)).toBe(OURS);
    expect(r.harness_text).toContain(`batch them.\n\n${OURS_MARKER}\nActive Hermes profile`);
    expect(r.harness_text).not.toContain('250 words');
    expect(r.tools).toEqual(['mcp__finance__calculate_emi', 'mcp__finance__list_debts']);
    expect(r.sha256).toBe(sha256Ref(r.system_text));
    expect(r.normalised).toHaveLength(2);
    expect(r.caveats[0]).toContain('fake/finance-emi');
  });

  it('gives the same sha on another day, so the cache key does not move with the date', () => {
    const a = renderFromRequest(hermesRequest(), OURS, PROBE);
    const other = hermesRequest();
    const msgs = other.messages as { content: string }[];
    msgs[0].content = msgs[0].content.replace('Wednesday, November 04, 2026', 'Friday, November 06, 2026');
    const b = renderFromRequest(other, OURS, PROBE);
    expect(a.ok && b.ok && a.rendered.sha256 === b.rendered.sha256).toBe(true);
  });

  it('finds our prompt without its trailing newline, as a harness may strip it', () => {
    const system = `Harness text.\n\n${OURS.trimEnd()} Harness text again.`;
    const out = renderFromRequest({ messages: [{ role: 'system', content: system }] }, OURS, PROBE);
    if (!out.ok) throw new Error(out.error);
    expect(out.rendered.system_text.slice(out.rendered.ours!.start, out.rendered.ours!.end)).toBe(OURS.trimEnd());
    expect(out.rendered.harness_text).toBe(`Harness text.\n\n${OURS_MARKER} Harness text again.`);
  });

  it('leaves only the marker when the harness adds nothing (own loop, Agents SDK)', () => {
    const out = renderFromRequest({ messages: [{ role: 'system', content: OURS }, { role: 'user', content: 'hi' }] }, OURS, PROBE);
    if (!out.ok) throw new Error(out.error);
    expect(out.rendered.harness_text).toBe(OURS_MARKER);
    expect(harnessOwnText(out.rendered.harness_text)).toBe('');
    expect(out.rendered.tools).toEqual([]);
  });

  it('joins content parts and several leading system messages', () => {
    const out = renderFromRequest(
      {
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'You are an agent.' }] },
          { role: 'developer', content: OURS },
          { role: 'user', content: 'hi' },
          { role: 'system', content: 'not part of the system prompt' },
        ],
      },
      OURS,
      PROBE,
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.rendered.system_text).toBe(`You are an agent.\n\n${OURS}`);
    expect(out.rendered.harness_text).toBe(`You are an agent.\n\n${OURS_MARKER}`);
    expect(out.rendered.caveats.some((c) => c.includes('2 system messages'))).toBe(true);
  });

  it('says so when our prompt is not in the system text verbatim', () => {
    const out = renderFromRequest({ messages: [{ role: 'system', content: 'Something else entirely.' }] }, OURS, PROBE);
    if (!out.ok) throw new Error(out.error);
    expect(out.rendered.ours).toBeNull();
    expect(out.rendered.harness_text).toBe('Something else entirely.');
    expect(out.rendered.caveats.some((c) => c.includes('not found verbatim'))).toBe(true);
  });

  it('refuses a body LiteLLM cut short, a request without a system message, and non-objects', () => {
    const cut = { messages: [{ role: 'system', content: `Hermes... ${TRUNCATION_NOTE} ...` }] };
    expect(renderFromRequest(cut, OURS, PROBE)).toMatchObject({ ok: false, error: expect.stringContaining(TRUNCATION_NOTE) as string });
    expect(renderFromRequest({ messages: [{ role: 'user', content: 'hi' }] }, OURS, PROBE)).toMatchObject({ ok: false, error: expect.stringContaining('no system message') as string });
    expect(renderFromRequest([], OURS, PROBE)).toMatchObject({ ok: false });
  });
});
