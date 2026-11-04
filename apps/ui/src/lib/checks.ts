/** The checks the run page makes before anything starts, from the configs, their harnesses'
 *  capabilities and the chosen tasks. Each is pass or fail, with the evidence in words. */
import { SETTING_NAMES, type ConfigView, type ConfigDiffEntry, type Estimate, type Harness, type TaskView } from '../api/types';
import { money, wholeMoney } from './format';
import { harnessName, harnessShort, settingLabel, splitName } from './names';

export interface Check {
  ok: boolean;
  title: string;
  detail: string;
}

/** Diff paths that are bookkeeping, not content: a name or a timestamp changes no result. */
export function contentDiff(diff: ConfigDiffEntry[]): ConfigDiffEntry[] {
  return diff.filter((d) => !/^(name|hash|created_at|settings_sources)(\.|$)/.test(d.path));
}

/** The one thing the arms differ in, read from the config diff paths. */
export function axisFromDiff(diff: ConfigDiffEntry[], sameConfig: boolean): string | null {
  if (sameConfig) return 'none';
  const content = contentDiff(diff);
  const harnessChanges = content.some((d) => d.path === 'harness');
  const areas = new Set(
    content.map((d) => {
      const [head, sub] = d.path.split('.');
      // The adapter's version and its capabilities file come with the harness (GET /configs/:a/diff/:b lists them).
      if (head === 'harness' || head === 'harness_ref' || head === 'adapter_version' || head === 'capabilities_sha256') return 'harness';
      // A setting only one of the two harnesses supports is part of changing the harness.
      if (harnessChanges && (head === 'harness_options' || (head === 'settings' && (d.a === null || d.a === undefined || d.b === null || d.b === undefined)))) return 'harness';
      if (head === 'settings' && sub) return sub;
      if (head === 'toolset') return 'tools';
      if (head === 'harness_options') return 'harness options';
      return head;
    }),
  );
  return areas.size === 1 ? [...areas][0] : null;
}

const AXIS_WORDS: Record<string, string> = { prompt: 'the system prompt', harness: 'the harness', model: 'the model', tools: 'the toolset', 'harness options': 'a harness option' };

export function axisPhrase(axis: string): string {
  return AXIS_WORDS[axis] ?? `the ${settingLabel(axis).toLowerCase()} setting`;
}

export function armsCheck(fullDiff: ConfigDiffEntry[], sameConfig: boolean): Check {
  const diff = contentDiff(fullDiff);
  if (sameConfig) return { ok: true, title: 'Both arms are the same config', detail: 'An A/A run: any difference it finds is the noise of the setup itself.' };
  const axis = axisFromDiff(diff, false);
  if (axis) {
    return {
      ok: true,
      title: `Only ${axisPhrase(axis)} differs between the arms`,
      detail: `Checked from the two saved configs: ${diff.map((d) => d.path).join(', ')}. Nothing else differs.`,
    };
  }
  if (!diff.length) return { ok: false, title: 'The two configs do not differ', detail: 'They differ only in name, so the run would compare an agent with itself. Pick two configs that differ in the one thing to compare.' };
  return { ok: false, title: 'The arms differ in more than one thing', detail: `They differ in ${diff.map((d) => d.path).join(', ')}, so a difference in results could not be pinned on one change.` };
}

export function capabilityCheck(configs: ConfigView[], harnesses: Harness[]): Check {
  const problems: string[] = [];
  for (const c of configs) {
    const h = harnesses.find((x) => x.name === c.harness);
    if (!h) {
      problems.push(`${c.harness} is not a known harness`);
      continue;
    }
    for (const name of SETTING_NAMES) {
      // Only what the config sets itself: the API leaves out, as null, whatever the harness cannot take.
      if (c.settings_sources[name] === 'config' && c.settings[name] !== null && !h.capabilities.settings[name]?.supported) {
        problems.push(`${harnessShort(h.name)} cannot apply ${settingLabel(name).toLowerCase()}`);
      }
    }
  }
  const names = [...new Set(configs.map((c) => harnessShort(c.harness)))];
  const who = names.length === 1 ? names[0] : names.join(' and ');
  if (problems.length) return { ok: false, title: 'A setting would be silently ignored', detail: `${problems.join('; ')}.` };
  return { ok: true, title: `${who} ${names.length === 1 ? 'supports' : 'support'} every setting in ${configs.length === 1 ? 'the config' : 'both configs'}`, detail: 'Nothing will be silently ignored.' };
}

export function planCheck(commit: string | null | undefined): Check {
  if (commit?.trim()) return { ok: true, title: 'The analysis plan was committed before the run', detail: `docs/experiment.md at commit ${commit.trim()}.` };
  return { ok: false, title: 'No analysis plan commit yet', detail: 'Commit the hypothesis and analysis plan in docs/experiment.md first, then give its commit here.' };
}

export function splitCheck(tasks: TaskView[], all: TaskView[]): Check {
  if (!tasks.length) return { ok: false, title: 'No tasks chosen', detail: 'Choose the tasks to run.' };
  const splits = new Set(tasks.map((t) => splitName(t.split)));
  if (splits.size > 1) return { ok: false, title: 'Discovery and held-out tasks are mixed', detail: 'A change found on the discovery tasks has to be measured on held-out tasks alone.' };
  const split = [...splits][0];
  if (split === 'held-out') {
    const discovery = all.filter((t) => splitName(t.split) === 'discovery').length;
    return {
      ok: true,
      title: `${tasks.length} held-out tasks, none of the discovery tasks`,
      detail: discovery ? 'Changes are made using the discovery tasks, so they stay out of this measurement.' : 'There are no discovery tasks in the catalogue.',
    };
  }
  return { ok: true, title: `${tasks.length} ${split} tasks`, detail: 'Discovery tasks are for finding problems; confirm a change on the held-out tasks.' };
}

export function budgetCheck(budget: number | undefined, estimate: Estimate | null): Check {
  if (!estimate) return { ok: false, title: 'No estimate yet', detail: 'The cost estimate has not come back.' };
  if (!budget || budget <= 0) return { ok: false, title: 'No spending limit set', detail: 'Set the LiteLLM budget for the whole experiment.' };
  if (budget < estimate.cost_usd.high) {
    return { ok: false, title: 'The spending limit is below the likely cost', detail: `It is ${wholeMoney(budget)}, but the run may cost up to ${money(estimate.cost_usd.high)}, so it could stop part-way.` };
  }
  return { ok: true, title: 'The spending limit covers the likely cost', detail: `${wholeMoney(budget)} against at most ${money(estimate.cost_usd.high)}.` };
}

export function harnessList(configs: ConfigView[]): string {
  return [...new Set(configs.map((c) => harnessName(c.harness)))].join(' and ');
}
