import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { ApiError } from '../api/errors';
import type { ConfigView as Config, ConflictCheckView } from '../api/types';
import configsJson from '../fixtures/configs.json';
import conflictChecks from '../fixtures/conflict-checks.json';
import { settle, useFixtures } from '../test/helpers';
import ConfigPage from './ConfigPage.vue';

useFixtures();

const configs = configsJson as unknown as Config[];
const byName = (name: string) => configs.find((c) => c.name === name) as Config;
const v1 = byName('Prompt v1 on Hermes');
const v2 = byName('Prompt v2 on Hermes');
const own = byName('Own loop, prompt v1');
const gemini = byName('Prompt v1 on Hermes, Gemini Flash');

describe('ConfigPage: what the config is', () => {
  it('shows every setting with where it comes from, and greys what the model ignores with the reason', async () => {
    const w = mount(ConfigPage, { props: { configHash: v1.hash } });
    await settle();
    expect(w.get('[data-test="config-title"]').text()).toBe('Prompt v1 on Hermes');
    const temp = w.get('[data-test="config-setting-temperature"]');
    expect(temp.classes()).toContain('row--ignored');
    expect(temp.text()).toContain("Not sent: Hermes's own default applies");
    expect(temp.get('[data-test="ignored-reason"]').text()).toBe("Claude Haiku 5.5 rejects temperature, so it is not sent and the provider's default applies");
    expect(w.get('[data-test="config-setting-max_steps"]').text()).toContain('12');
    expect(w.get('[data-test="config-setting-max_steps"]').text()).toContain('Set in this config');
    expect(w.get('[data-test="config-setting-memory"]').text()).toContain('Off');
    expect(w.get('[data-test="config-seed"]').text()).toContain('Nothing seeded');
  });

  it('names its parent, compares with it on request, lists its forks, and links to a fork of itself', async () => {
    const diff = vi.spyOn(api, 'configDiff');
    const w = mount(ConfigPage, { props: { configHash: v2.hash } });
    await settle();
    const lineage = w.get('[data-test="lineage"]');
    expect(lineage.text()).toContain('Forked from Prompt v1 on Hermes');
    expect(diff).not.toHaveBeenCalled();
    await lineage.get('[data-test="compare-parent"]').trigger('click');
    await settle();
    expect(diff).toHaveBeenCalledWith(v1.hash, v2.hash);
    // In words with both values, as the comparison words them; the field paths only behind Details (QA round 3, minor 3).
    expect(w.get('[data-test="parent-diff"]').text()).toBe('System prompt: v1 to v2');
    expect(w.get('[data-test="parent-fields"]').attributes('open')).toBeUndefined();
    expect(w.get('[data-test="parent-fields"]').text()).toContain('prompt.version: v1 to v2');
    expect(w.get('[data-test="fork"]').attributes('href')).toBe(`#/configs?fork=${encodeURIComponent(v2.hash)}`);
    const parent = mount(ConfigPage, { props: { configHash: v1.hash } });
    await settle();
    // A comma straight after each name: no space before it.
    expect(parent.get('[data-test="children"]').text()).toBe('Forked into: Prompt v2 on Hermes, Prompt v1 on Hermes, Gemini Flash');
    expect(parent.findAll('[data-test="children"] a').map((a) => a.attributes('href'))).toEqual([v2.hash, gemini.hash].map((h) => `#/configs/${encodeURIComponent(h)}`));
  });
});

describe('ConfigPage: the rendered prompt (D33)', () => {
  it("shows the whole system prompt with ours marked inside the harness's text, and its caveat", async () => {
    const w = mount(ConfigPage, { props: { configHash: v1.hash } });
    await settle();
    const panel = w.get('[data-test="rendered-prompt"]');
    expect(panel.get('[data-test="rendered-summary"]').text()).toMatch(/^Our prompt is \d+% of it; the rest is Hermes's\. 11 tools sent with it\.$/);
    const ours = panel.get('[data-test="ours"]');
    expect(ours.text()).toContain('Our prompt, finance-advisor v1, starts');
    expect(ours.text()).toContain('Our prompt ends');
    expect(panel.get('[data-test="system-text"]').text().startsWith('You are Hermes Agent, built by Nous Research.')).toBe(true);
    expect(panel.get('[data-test="rendered-caveats"]').text()).toContain('The probe ran on fake/finance-emi');
    await panel.get('[data-test="harness-only"]').trigger('click');
    expect(panel.get('[data-test="system-text"]').text()).toContain('<<OUR TASK PROMPT>>');
    expect(panel.find('[data-test="ours"]').exists()).toBe(false);
  });

  it('says a harness that adds nothing adds nothing', async () => {
    const w = mount(ConfigPage, { props: { configHash: own.hash } });
    await settle();
    expect(w.get('[data-test="rendered-summary"]').text()).toBe('Own loop adds nothing: the model gets our prompt as it is.');
    expect(w.get('[data-test="check-skipped"]').text()).toContain('no call was made and it cost nothing');
  });

  it('asks for no stored conflict check while the prompt is not rendered: the API could only refuse', async () => {
    const stored = vi.spyOn(api, 'conflictCheck');
    const w = mount(ConfigPage, { props: { configHash: v2.hash } });
    await settle();
    expect(w.find('[data-test="needs-render"]').exists()).toBe(true);
    expect(stored).not.toHaveBeenCalled();
  });

  it('renders a prompt not rendered yet with a free probe, and the conflict check waits for it', async () => {
    const render = vi.spyOn(api, 'renderPrompt').mockResolvedValue({ config_hash: v2.hash, status: 'queued', probe: { trial_id: 't_probe_new', status: 'queued', label: null, model: 'fake/finance-emi' }, cached: false, error: null, rendered: null });
    const w = mount(ConfigPage, { props: { configHash: v2.hash } });
    await settle();
    expect(w.get('[data-test="rendered-status"]').text()).toBe('Not rendered yet.');
    expect(w.get('[data-test="needs-render"]').text()).toBe('Render the prompt first: the check reads it.');
    await w.get('[data-test="render-prompt"]').trigger('click');
    await settle();
    expect(render).toHaveBeenCalledWith(v2.hash);
    expect(w.get('[data-test="rendered-status"]').text()).toContain('A probe trial is queued for the Hermes worker');
  });
});

describe('ConfigPage: an id that is no saved agent', () => {
  it('says "No agent with that id" in plain words, not the validator\'s text', async () => {
    const w = mount(ConfigPage, { props: { configHash: 'not-a-hash' } });
    await settle();
    const page = w.get('[data-test="config-missing"]');
    expect(page.get('h1').text()).toBe('No agent with that id');
    expect(page.get('.crumbs').text()).toBe('Configs / Not found');
    expect(page.text()).toContain('Nothing is saved as not-a-hash.');
    expect(w.find('[data-test="load-error"]').exists()).toBe(false);
    expect(w.text()).not.toContain('sha256:<64 hex>');
  });
});

describe('ConfigPage: the conflict check (D38)', () => {
  it('shows each finding with its severity and both quotes, what the check cost, that it was cached, and the allowance', async () => {
    const run = vi.spyOn(api, 'runConflictCheck');
    const w = mount(ConfigPage, { props: { configHash: v1.hash } });
    await settle();
    const panel = w.get('[data-test="conflict-check"]');
    expect(panel.get('[data-test="check-summary"]').text().replace(/\s+/g, ' ')).toMatch(/^6 conflicts \(4 medium, 2 low\) found by Claude Sonnet 5\.5, checker conflict-check v1/);
    const findings = panel.findAll('[data-test="finding"]');
    expect(findings).toHaveLength(6);
    expect(findings.map((f) => f.get('[data-test="severity"]').text())).toEqual(['Medium', 'Medium', 'Medium', 'Medium', 'Low', 'Low']);
    const first = (conflictChecks as unknown as Record<string, ConflictCheckView>)[v1.hash].conflicts.find((c) => c.severity === 'medium');
    expect(findings[0].text()).toContain(`Hermes says “${first?.harness_says}”`);
    expect(findings[0].text()).toContain(`We say “${first?.we_say}”`);
    expect(findings[0].text()).toContain(first?.why_it_matters ?? '');
    expect(panel.get('[data-test="check-cost"]').text()).toContain('This check cost $0.0183 when it ran; showing the stored result, so this view spent nothing.');
    expect(panel.get('[data-test="allowance"] [role="img"]').attributes('aria-label')).toBe('Conflict-check allowance: $0.0183 of $2 used, $1.98 left, 1 call');
    // A stored result: no paid button at all.
    expect(panel.find('[data-test="run-check"]').exists()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a check only after the person confirms a paid call, then shows it and updates the spend', async () => {
    const stored = (conflictChecks as unknown as Record<string, ConflictCheckView>)[v1.hash];
    const run = vi.spyOn(api, 'runConflictCheck').mockResolvedValue({ ...stored, config_hash: gemini.hash, cached: false, cost_usd: 0.0201 });
    const spend = vi.fn();
    window.addEventListener('evals:spend-changed', spend);
    const w = mount(ConfigPage, { props: { configHash: gemini.hash } });
    await settle();
    const panel = w.get('[data-test="conflict-check"]');
    expect(panel.text()).toContain('This config has not been checked yet.');
    await panel.get('[data-test="run-check"]').trigger('click');
    expect(run).not.toHaveBeenCalled();
    const confirm = panel.get('[data-test="confirm-check"]');
    expect(confirm.text()).toContain("This is a real call to Claude Sonnet 5.5, paid from the platform's own allowance");
    expect(confirm.text()).toContain('It costs up to about $0.03');
    expect(confirm.text()).toContain('$1.98 of the $2 allowance is left.');
    await confirm.get('[data-test="confirm-run-check"]').trigger('click');
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(gemini.hash);
    expect(panel.get('[data-test="check-cost"]').text()).toContain('This check cost $0.0201 when it ran.');
    expect(spend).toHaveBeenCalledTimes(1);
    window.removeEventListener('evals:spend-changed', spend);
  });

  it('explains a check that failed for want of a key in plain words, with the raw error behind Details', async () => {
    const raw =
      'LiteLLM answered 401: {"error":{"message":"litellm.AuthenticationError: AnthropicException - x-api-key header is required"}} (recorded as system spend ss_1, $0)';
    vi.spyOn(api, 'runConflictCheck').mockRejectedValue(new ApiError(502, 'checker_call_failed', raw));
    const w = mount(ConfigPage, { props: { configHash: gemini.hash } });
    await settle();
    await w.get('[data-test="run-check"]').trigger('click');
    await w.get('[data-test="confirm-run-check"]').trigger('click');
    await settle();
    expect(w.get('[data-test="check-error"]').text()).toBe(
      "The prompt check's model (Claude Sonnet 5.5) needs its provider key: add it to .env and restart the stack (docker compose up -d). No check was stored.",
    );
    expect(w.get('[data-test="check-error-details"] pre').text()).toBe(raw);
    // The panel says what happened: tried and failed, not "not checked yet".
    expect(w.get('[data-test="check-state"]').text()).toBe('No check is stored for this config: the last try did not finish.');
    expect(w.get('[data-test="run-check"]').text()).toBe('Try the check again…');
    expect(w.find('[data-test="confirm-check"]').exists()).toBe(false);
  });

  it('shows a refused check with the API fix, such as an exhausted allowance', async () => {
    vi.spyOn(api, 'runConflictCheck').mockRejectedValue(new ApiError(402, 'allowance_exhausted', 'the conflict-check allowance of $2 is used up', 'Ask Rishi to raise EVALS_CONFLICT_CHECK_ALLOWANCE_USD.'));
    const w = mount(ConfigPage, { props: { configHash: gemini.hash } });
    await settle();
    await w.get('[data-test="run-check"]').trigger('click');
    await w.get('[data-test="confirm-run-check"]').trigger('click');
    await settle();
    expect(w.get('[data-test="check-error"]').text()).toBe('the conflict-check allowance of $2 is used up. Ask Rishi to raise EVALS_CONFLICT_CHECK_ALLOWANCE_USD.');
  });

  it('reads "no check stored" from a 200 null, so an unchecked config logs no error', async () => {
    const stored = vi.spyOn(api, 'conflictCheck');
    const w = mount(ConfigPage, { props: { configHash: gemini.hash } });
    await settle();
    expect(await stored.mock.results[0]?.value).toBeNull();
    expect(w.get('[data-test="check-state"]').text()).toBe('This config has not been checked yet.');
    expect(w.find('[data-test="run-check"]').attributes('disabled')).toBeUndefined();
  });

  it('turns the paid check off while the checker’s key is not set, and says what to add', async () => {
    vi.spyOn(api, 'models').mockResolvedValue([
      { name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false },
      { name: 'claude-sonnet-5-5', provider: 'anthropic', input_per_mtok: 2, output_per_mtok: 10, key_set: false },
    ]);
    const run = vi.spyOn(api, 'runConflictCheck');
    const w = mount(ConfigPage, { props: { configHash: gemini.hash } });
    await settle();
    expect(w.get('[data-test="run-check"]').attributes('disabled')).toBeDefined();
    expect(w.get('[data-test="check-needs-key"]').text()).toBe(
      'The check calls Claude Sonnet 5.5, which needs ANTHROPIC_API_KEY in .env. Add it, then run docker compose up -d and reload this page.',
    );
    await w.get('[data-test="run-check"]').trigger('click');
    expect(w.find('[data-test="confirm-check"]').exists()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('ConfigPage: keys and the shipped example', () => {
  it('says when the config’s own model needs a key that is not set', async () => {
    vi.spyOn(api, 'models').mockResolvedValue([{ name: 'claude-haiku-5-5', provider: 'anthropic', input_per_mtok: 0.1, output_per_mtok: 0.5, key_set: false }]);
    const w = mount(ConfigPage, { props: { configHash: v1.hash } });
    await settle();
    expect(w.get('[data-test="config-needs-key"]').text()).toBe('Claude Haiku 5.5 needs ANTHROPIC_API_KEY in .env to run: it is not set. Add it, then run docker compose up -d.');
  });

  it('offers a shipped example’s config to fork, not to run again, and says why', async () => {
    const example: Config = { ...own, hash: `sha256:90a6761${'0'.repeat(57)}`, name: 'v2 sim check, ownloop, haiku', example_only: true, parent_hash: null };
    vi.spyOn(api, 'config').mockResolvedValue({ ...example, children: [] });
    const w = mount(ConfigPage, { props: { configHash: example.hash } });
    await settle();
    expect(w.get('[data-test="config-example-only"]').text()).toContain('This config came with the shipped example');
    expect(w.get('[data-test="fork"]').attributes('href')).toBe(`#/configs?fork=${encodeURIComponent(example.hash)}`);
    expect(w.find('[data-test="set-up-run"]').exists()).toBe(false);
  });
});
