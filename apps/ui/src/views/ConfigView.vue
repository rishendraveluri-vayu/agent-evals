<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import { api } from '../api/client';
import { ApiError, errorText, errorWithFix } from '../api/errors';
import { SETTING_NAMES, type ConfigDiffEntry, type ConfigView, type ConfigWarning, type CreatedPrompt, type Harness, type JsonObject, type ModelView, type PromptView, type SeedSkill, type SettingName, type ToolsetView } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import LoadState from '../components/LoadState.vue';
import { useLoad } from '../lib/async';
import { coverageText } from '../lib/capabilities';
import { changedLineCount, lineChanges, sentenceChanges } from '../lib/diff';
import { mdBlocks } from '../lib/markdown';
import { plainText, shortHash, shortRef } from '../lib/format';
import { BOOLEAN_SETTINGS, harnessName, harnessShort, modelName, settingLabel } from '../lib/names';
import { agentModels, fakeDoes, isFake } from '../lib/models';
import { NAME_MAX, settingProblem } from '../lib/limits';
import { ignoredReasons, toggleValue } from '../lib/settings';
import { href, navigate } from '../router';
import { text } from '../trials';

/** `fork`: start as a copy of that saved config and save the new one as its child (D34). */
const props = defineProps<{ fork?: string | null }>();

interface Loaded {
  harnesses: Harness[];
  models: ModelView[];
  prompts: PromptView[];
  toolsets: ToolsetView[];
  configs: ConfigView[];
}

const { data, error, loading } = useLoad<Loaded>(async () => {
  const [harnesses, models, prompts, toolsets, configs] = await Promise.all([api.harnesses(), api.models(), api.prompts(), api.toolsets(), api.configs()]);
  return { harnesses, models, prompts, toolsets, configs };
});

const numbers: Partial<Record<SettingName, string>> = {};
const toggles: Partial<Record<SettingName, boolean>> = {};
const options: Record<string, string> = {};
const form = reactive({
  name: '',
  harness: '',
  model: '',
  prompt: '',
  toolset: '',
  numbers,
  toggles,
  options,
});
const nameTouched = ref(false);
const baseHash = ref('');
const saving = ref(false);
/** A refusal from POST /configs: its message, the API's fix, and the field it is about. */
const refusal = ref<{ field: string | null; code: string; message: string; fix: string | null } | null>(null);
const saved = ref<ConfigView | null>(null);
/** The save returned a config that was already stored (the same content, under its own name). */
const existed = ref(false);
const apiDiff = shallowRef<ConfigDiffEntry[] | null>(null);
const showPrompt = ref(false);
const showPromptDiff = ref(false);
/** Model refusals learnt from a 400 this session, by model, for configs not saved yet. */
const learnt = reactive<Record<string, Partial<Record<SettingName, string>>>>({});
/** Seeds (D39): the memory entries, one per line, and the skills every trial starts with. */
const seedMemory = ref('');
const seedSkills = reactive<SeedSkill[]>([]);

const versionNumber = (v: string) => Number(v.replace(/^v/, '')) || 0;
const byAge = (configs: ConfigView[]) => [...configs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

/** A new config starts as a copy of the oldest saved one (the baseline) with the newest version
 *  of its prompt, so trying a new prompt is one click and the diff says exactly what moved. A fork
 *  starts as an exact copy of the config it forks. */
watch(data, (d) => {
  if (!d || form.harness) return;
  const forked = props.fork ? d.configs.find((c) => c.hash === props.fork) : undefined;
  const base = forked ?? byAge(d.configs)[0];
  baseHash.value = base?.hash ?? '';
  form.harness = base?.harness ?? d.harnesses[0]?.name ?? '';
  form.model = base?.model ?? d.models[0]?.name ?? agentModels([]).fake[0]?.name ?? '';
  const promptId = base?.prompt.id ?? d.prompts.find((p) => p.id !== 'client-sim' && p.id !== 'conflict-check')?.id ?? d.prompts[0]?.id;
  const newest = d.prompts.filter((p) => p.id === promptId).sort((a, b) => versionNumber(b.version) - versionNumber(a.version))[0];
  form.prompt = forked ? forked.prompt.sha256 : (newest?.sha256 ?? d.prompts[0]?.sha256 ?? '');
  form.toolset = base?.toolset.sha256 ?? d.toolsets[0]?.sha256 ?? '';
  for (const name of SETTING_NAMES) {
    const value = base?.settings[name];
    // Only what the base config set itself is copied; defaults stay defaults.
    const own = base?.settings_sources[name] === 'config';
    if (BOOLEAN_SETTINGS.includes(name)) form.toggles[name] = toggleValue(value) === true;
    else form.numbers[name] = own && typeof value === 'number' ? String(value) : '';
  }
  for (const [k, v] of Object.entries(base?.harness_options ?? {})) form.options[k] = text(v);
  seedMemory.value = (base?.seed?.memory ?? []).join('\n');
  seedSkills.splice(0, seedSkills.length, ...(base?.seed?.skills ?? []).map((k) => ({ ...k })));
  if (forked) {
    form.name = `${forked.name}, fork`;
    nameTouched.value = true;
  }
});

const harness = computed(() => data.value?.harnesses.find((h) => h.name === form.harness) ?? null);
const model = computed(() => data.value?.models.find((m) => m.name === form.model) ?? null);
const prompt = computed(() => data.value?.prompts.find((p) => p.sha256 === form.prompt) ?? null);
const toolset = computed(() => data.value?.toolsets.find((t) => t.sha256 === form.toolset) ?? null);
const base = computed(() => data.value?.configs.find((c) => c.hash === baseHash.value) ?? null);
const forkOf = computed(() => (props.fork ? (data.value?.configs.find((c) => c.hash === props.fork) ?? null) : null));
/** The address names a config to fork that is not saved: say so, and start a new config instead. */
const forkMissing = computed(() => !!props.fork && !!data.value && !forkOf.value);
const tools = computed(() => toolset.value?.servers.flatMap((s) => s.allowed_tools) ?? []);
const modelGroups = computed(() => agentModels(data.value?.models ?? []));
/** Task prompts only: the simulator's and the checker's prompts are not a config's to pick. */
const taskPrompts = computed(() => data.value?.prompts.filter((p) => p.id !== 'client-sim' && p.id !== 'conflict-check') ?? []);

const supported = (name: SettingName) => harness.value?.capabilities.settings[name]?.supported ?? false;

/** Every setting this harness or model ignores, with the reason to show by the greyed field. */
const ignored = computed<Partial<Record<SettingName, string>>>(() => ({
  ...ignoredReasons(form.harness, harness.value?.capabilities.settings, form.model, data.value?.configs ?? []),
  ...(learnt[form.model] ?? {}),
}));
const isIgnored = (name: SettingName) => !!ignored.value[name];

/** The settings the form sets: numbers left empty are unset; toggles are always set. A setting
 *  the harness or the model ignores is never sent. */
const settings = computed(() => {
  const out: Partial<Record<SettingName, number | boolean | { enabled: boolean }>> = {};
  for (const name of SETTING_NAMES) {
    if (!supported(name) || isIgnored(name)) continue;
    if (name === 'parallel_tool_calls') out[name] = form.toggles[name] === true;
    else if (BOOLEAN_SETTINGS.includes(name)) out[name] = { enabled: form.toggles[name] === true };
    else {
      const raw = form.numbers[name]?.trim();
      if (raw) out[name] = Number(raw);
    }
  }
  return out;
});

const optionProps = computed(() => Object.entries(harness.value?.capabilities.harness_options_schema.properties ?? {}));
const harnessOptions = computed(() => {
  const out: JsonObject = {};
  for (const [k, schema] of optionProps.value) {
    const raw = form.options[k];
    if (raw === undefined || raw === '') continue;
    out[k] = schema.type === 'boolean' ? raw === 'true' : schema.type === 'number' || schema.type === 'integer' ? Number(raw) : raw;
  }
  return out;
});

/** What the config seeds, when memory or skills is on for a harness that takes it; null for none,
 *  so a config without seeds keeps its hash. */
const seed = computed(() => {
  const memory = supported('memory') && form.toggles.memory ? seedMemory.value.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  const skills =
    supported('skills') && form.toggles.skills
      ? seedSkills.filter((k) => k.name.trim() || k.body.trim()).map((k) => ({ name: k.name.trim(), description: k.description.trim(), body: k.body }))
      : [];
  return memory.length || skills.length ? { memory, skills } : null;
});
const seedWords = (s: { memory?: string[]; skills?: SeedSkill[] } | null | undefined) => {
  const m = s?.memory?.length ?? 0;
  const k = s?.skills?.length ?? 0;
  if (!m && !k) return 'none';
  return [m ? `${m} memory ${m === 1 ? 'entry' : 'entries'}` : '', k ? `${k} ${k === 1 ? 'skill' : 'skills'}` : ''].filter(Boolean).join(', ');
};
const addSkill = () => seedSkills.push({ name: '', description: '', body: '' });
const removeSkill = (i: number) => seedSkills.splice(i, 1);

// ---------------------------------------------------------------- a new prompt version

const editingPrompt = ref(false);
const draftText = ref('');
const promptSaving = ref(false);
const promptRefusal = ref<string | null>(null);
const promptSaved = ref<{ created: CreatedPrompt; existed: boolean } | null>(null);
const draftLines = computed(() => (prompt.value ? changedLineCount(lineChanges(prompt.value.text, draftText.value)) : 0));
/** The version POST /prompts will write: the highest v<n> of this prompt plus one. */
const nextVersion = computed(() => {
  const p = prompt.value;
  if (!p || !data.value) return '';
  const n = Math.max(0, ...data.value.prompts.filter((x) => x.id === p.id).map((x) => Number(/^v(\d+)$/.exec(x.version)?.[1] ?? 0)));
  return `v${n + 1}`;
});
const newPromptButton = ref<HTMLButtonElement | null>(null);
/** Cancel, the button or Escape: the draft goes, and focus returns to the button that opened it. */
async function cancelPromptEdit() {
  if (promptSaving.value) return;
  editingPrompt.value = false;
  await nextTick();
  newPromptButton.value?.focus();
}
function startPromptEdit() {
  if (!prompt.value) return;
  draftText.value = prompt.value.text;
  promptRefusal.value = null;
  promptSaved.value = null;
  editingPrompt.value = true;
}
async function savePrompt() {
  const base = prompt.value;
  const d = data.value;
  if (!base || !d || !draftText.value.trim() || !draftLines.value) return;
  promptSaving.value = true;
  promptRefusal.value = null;
  try {
    const known = new Set(d.prompts.map((p) => p.sha256));
    const created = await api.createPrompt({ id: base.id, base_version: base.version, text: draftText.value });
    const prompts = await api.prompts();
    data.value = { ...d, prompts };
    form.prompt = created.sha256;
    promptSaved.value = { created, existed: known.has(created.sha256) };
    editingPrompt.value = false;
  } catch (err) {
    promptRefusal.value = plainText(errorWithFix(err));
  } finally {
    promptSaving.value = false;
  }
}

/** "Prompt v2 on Hermes, Claude Haiku 5.5": the model is in it, so two configs that differ only in
 *  their model never share a name in a list. */
const suggestedName = computed(() => (prompt.value && harness.value ? `Prompt ${prompt.value.version} on ${harnessShort(harness.value.name)}${form.model ? `, ${modelName(form.model)}` : ''}` : ''));
watch(suggestedName, (n) => {
  if (!nameTouched.value) form.name = n;
});

/** Why a typed setting cannot be saved, by setting, shown by its field. */
const problems = computed<Partial<Record<SettingName, string>>>(() => {
  const out: Partial<Record<SettingName, string>> = {};
  for (const name of SETTING_NAMES) {
    if (!supported(name) || isIgnored(name) || BOOLEAN_SETTINGS.includes(name)) continue;
    const problem = settingProblem(name, form.numbers[name]);
    if (problem) out[name] = problem;
  }
  return out;
});

/** Why Save is off, in words; null when it is on. */
const invalid = computed(() => {
  const first = SETTING_NAMES.find((name) => problems.value[name]);
  if (first) return `Not saved yet: ${problems.value[first]}`;
  if (!form.name.trim()) return 'Give the config a name to save it.';
  return null;
});

/** PLATFORM_DEFAULTS in apps/api/src/configs/settings.ts: what the API stores for a setting left unset. */
const PLATFORM_DEFAULTS: Record<SettingName, unknown> = {
  temperature: null,
  max_output_tokens: 8192,
  max_steps: 15,
  timeout_s: 300,
  parallel_tool_calls: false,
  memory: { enabled: false },
  skills: { enabled: false },
  compression: { enabled: false },
};
/** The value the API would store for a setting from this form: the hash is over these, so a value
 *  set to its default is no change. */
const resolvedNow = (name: SettingName) => (!supported(name) || isIgnored(name) ? null : (settings.value[name] ?? PLATFORM_DEFAULTS[name]));
const shown = (v: unknown) =>
  v === undefined || v === null ? 'not sent' : typeof v === 'object' && 'enabled' in v ? ((v as { enabled: boolean }).enabled ? 'on' : 'off') : text(v);

/** What differs from the comparison config, in words. */
const changes = computed(() => {
  const b = base.value;
  if (!b) return [];
  const out: string[] = [];
  if (b.harness !== form.harness) out.push(`Harness: ${harnessShort(b.harness)} to ${harnessShort(form.harness)}`);
  if (b.model !== form.model) out.push(`Model: ${modelName(b.model)} to ${modelName(form.model)}`);
  if (b.prompt.sha256 !== form.prompt) out.push(`Prompt: ${b.prompt.id === prompt.value?.id ? '' : `${b.prompt.id} `}${b.prompt.version} to ${prompt.value?.id === b.prompt.id ? '' : `${prompt.value?.id} `}${prompt.value?.version ?? '?'}`);
  if (b.toolset.sha256 !== form.toolset) out.push(`Toolset: ${b.toolset.id} ${b.toolset.version} to ${toolset.value?.id} ${toolset.value?.version}`);
  for (const name of SETTING_NAMES) {
    const was = b.settings[name];
    const now = resolvedNow(name);
    if (shown(was) !== shown(now)) out.push(`${settingLabel(name)}: ${shown(was)} to ${shown(now)}`);
  }
  if (JSON.stringify(b.seed?.memory?.length || b.seed?.skills?.length ? b.seed : null) !== JSON.stringify(seed.value)) out.push(`Seed: ${seedWords(b.seed)} to ${seedWords(seed.value)}`);
  const keys = new Set([...Object.keys(b.harness_options), ...Object.keys(harnessOptions.value)]);
  for (const k of keys) {
    if (text(b.harness_options[k]) !== text(harnessOptions.value[k])) out.push(`${settingLabel(k)}: ${text(b.harness_options[k] ?? 'default')} to ${text(harnessOptions.value[k] ?? 'default')}`);
  }
  return out;
});

/** The saved config with exactly this content, if there is one: saving would return it. */
const sameAs = computed(() => {
  const d = data.value;
  if (!d) return null;
  const same = (c: ConfigView) =>
    c.harness === form.harness &&
    c.model === form.model &&
    c.prompt.sha256 === form.prompt &&
    c.toolset.sha256 === form.toolset &&
    SETTING_NAMES.every((name) => shown(c.settings[name]) === shown(resolvedNow(name))) &&
    JSON.stringify(c.seed?.memory?.length || c.seed?.skills?.length ? c.seed : null) === JSON.stringify(seed.value) &&
    JSON.stringify(Object.entries(c.harness_options).sort()) === JSON.stringify(Object.entries(harnessOptions.value).sort());
  return d.configs.find(same) ?? null;
});
const shownHash = computed(() => saved.value?.hash ?? sameAs.value?.hash ?? null);

/** Warnings for this harness and model: from the saved config once saved, else from any saved
 *  config with the same harness and model (the API works them out from those two alone). */
const warnings = computed<ConfigWarning[]>(() => {
  if (saved.value) return saved.value.warnings ?? [];
  return data.value?.configs.find((c) => c.harness === form.harness && c.model === form.model && c.warnings?.length)?.warnings ?? [];
});

// The prompt against the previous version of the same prompt.
const previousPrompt = computed(() => {
  const p = prompt.value;
  if (!p || !data.value) return null;
  return (
    data.value.prompts
      .filter((x) => x.id === p.id && versionNumber(x.version) < versionNumber(p.version))
      .sort((a, b) => versionNumber(b.version) - versionNumber(a.version))[0] ?? null
  );
});
const promptChanges = computed(() => (previousPrompt.value && prompt.value ? lineChanges(previousPrompt.value.text, prompt.value.text) : []));
const promptSentences = computed(() => (previousPrompt.value && prompt.value ? sentenceChanges(previousPrompt.value.text, prompt.value.text) : []));
const promptBlocks = computed(() => (prompt.value ? mdBlocks(prompt.value.text) : []));
const perMillion = (v: number | null) => (v === null ? 'not priced' : `$${v.toFixed(2)}`);

function settingNote(name: SettingName): string {
  const cap = harness.value?.capabilities.settings[name];
  const who = harness.value ? harnessShort(harness.value.name) : 'The harness';
  switch (name) {
    case 'max_output_tokens':
      return 'Per model call';
    case 'max_steps':
      return `One step is one model call.${cap?.extra_calls_at_limit ? ` ${who} may make ${cap.extra_calls_at_limit} more at the limit.` : ''}`;
    case 'timeout_s':
      return 'Whole trial, in seconds';
    case 'memory':
    case 'skills':
      return 'Seeded per task when on';
    case 'compression':
      return cap?.default === true ? `${who} turns it on by itself; it stays off unless you turn it on` : '';
    default:
      return '';
  }
}

/** What happens when a setting is left unset (D25, R11b): the platform's default, or nothing sent
 *  so the harness's or provider's own default applies. */
const PLATFORM_DEFAULT_WORDS: Partial<Record<SettingName, string>> = { max_output_tokens: '8,192', max_steps: '15', timeout_s: '300 s', parallel_tool_calls: 'Off' };
function ifUnset(name: SettingName): string {
  const cap = harness.value?.capabilities.settings[name];
  const who = harness.value ? harnessShort(harness.value.name) : 'harness';
  if (!cap?.supported) return `Not supported by ${harness.value ? harnessName(harness.value.name) : 'this harness'}`;
  if (isIgnored(name)) return `Not sent: ${modelName(form.model)} refuses it`;
  if (name === 'memory' || name === 'skills' || name === 'compression') return cap.default === true ? `Off (${who} default is on)` : 'Off';
  if (name === 'temperature') return cap.default === null || cap.default === undefined ? 'Not sent; provider default' : `Not sent; ${who} default ${text(cap.default)}`;
  return `Platform default, ${PLATFORM_DEFAULT_WORDS[name] ?? 'set by the API'}`;
}

function effect(name: SettingName): { text: string; kind: 'yes' | 'no' | 'todo' | 'na' } {
  const cap = harness.value?.capabilities.settings[name];
  if (!cap?.supported || isIgnored(name)) return { text: '–', kind: 'na' };
  if (name === 'timeout_s' || cap.native === 'wrapper' || cap.native === 'adapter watchdog') return { text: 'Not applicable', kind: 'na' };
  const e = cap.effect?.[form.model];
  const m = modelName(form.model);
  if (e?.status === 'effective') return { text: `Yes, on ${m}`, kind: 'yes' };
  if (e?.status === 'inert') return { text: `No change seen on ${m}`, kind: 'no' };
  return { text: 'Not checked yet', kind: 'todo' };
}

function versionLine(h: Harness): string {
  return /^[0-9a-f]{40}$/.test(h.ref) ? `Pinned at ${shortRef(h.ref)}` : `${h.package} ${h.ref}`;
}

/** Which field a refusal is about, so its fix shows by that field: a setting it names, or the
 *  harness, model, prompt or toolset by its code. */
const FIELD_OF_CODE: Record<string, string> = {
  unknown_harness: 'harness',
  unknown_model: 'model',
  unknown_prompt: 'prompt',
  unknown_toolset: 'toolset',
  invalid_harness_options: 'options',
  invalid_seed: 'seed',
  unsupported_seed: 'seed',
  seed_feature_off: 'seed',
};
function fieldOf(err: ApiError): string | null {
  if (FIELD_OF_CODE[err.code]) return FIELD_OF_CODE[err.code];
  if (err.code === 'unsupported_setting' || err.code === 'invalid_setting' || err.code === 'unknown_setting') {
    const named = [...SETTING_NAMES].sort((a, b) => b.length - a.length).find((n) => new RegExp(`\\b${n}\\b`).test(err.message));
    return named ?? null;
  }
  return null;
}
const refusalFor = (field: string) => (refusal.value?.field === field ? refusal.value : null);

async function save(thenRun: boolean) {
  const d0 = data.value;
  if (invalid.value || !d0 || !harness.value || !prompt.value || !toolset.value) return;
  saving.value = true;
  refusal.value = null;
  try {
    const config = await api.createConfig({
      name: form.name.trim(),
      harness: form.harness,
      model: form.model,
      prompt_sha256: form.prompt,
      toolset_sha256: form.toolset,
      settings: settings.value,
      harness_options: harnessOptions.value,
      ...(seed.value ? { seed: seed.value } : {}),
      ...(forkOf.value ? { parent_hash: forkOf.value.hash } : {}),
    });
    // The API returns the stored config when this content exists already, under the name it was
    // first saved with; the name typed here is not used.
    existed.value = d0.configs.some((c) => c.hash === config.hash) || config.name !== form.name.trim();
    saved.value = config;
    apiDiff.value = base.value && base.value.hash !== config.hash ? await api.configDiff(base.value.hash, config.hash) : [];
    if (thenRun) navigate(href.runNew(base.value && base.value.hash !== config.hash ? base.value.hash : undefined, config.hash));
  } catch (err) {
    if (err instanceof ApiError) {
      const field = fieldOf(err);
      refusal.value = { field, code: err.code, message: plainText(err.message), fix: err.fix ? plainText(err.fix) : null };
      // A model's refusal holds for every config on that model: grey the field from now on.
      if (err.code === 'unsupported_setting' && field && supported(field as SettingName) && err.message.includes(form.model)) {
        learnt[form.model] = { ...(learnt[form.model] ?? {}), [field]: err.fix ?? err.message };
      }
    } else {
      refusal.value = { field: null, code: 'error', message: plainText(errorText(err)), fix: null };
    }
  } finally {
    saving.value = false;
  }
}

watch(
  () => [form.harness, form.model, form.prompt, form.toolset, JSON.stringify(settings.value), JSON.stringify(harnessOptions.value), JSON.stringify(seed.value)],
  () => {
    saved.value = null;
    existed.value = false;
    apiDiff.value = null;
  },
);
</script>

<template>
  <div class="page-head">
    <nav
      aria-label="Breadcrumb"
      class="crumbs"
    >
      <a :href="href.experiments()">Experiments</a> / {{ fork && !forkMissing ? 'Fork a config' : 'New config' }}
    </nav>
    <h1 tabindex="-1">
      {{ fork && !forkMissing ? 'Fork a config' : 'Define a config' }}
    </h1>
    <p
      v-if="forkMissing"
      class="lede fork-missing"
      role="alert"
      data-test="fork-missing"
    >
      No saved config has the id <span class="mono">{{ fork }}</span>, so there is nothing to fork. This page starts a new config instead; <a :href="href.config()">Configs</a> lists every saved one.
    </p>
    <p class="lede">
      <template v-if="forkOf">
        A copy of <a :href="href.configPage(forkOf.hash)">{{ forkOf.name }}</a>. Change the one thing this fork is meant to test; saving records {{ forkOf.name }} as its parent.
      </template>
      <template v-else>
        A config is one harness, one model, one prompt, one toolset and its settings. Saving it gives it a content hash, so every result points back to exactly what produced it.
      </template>
    </p>
  </div>

  <LoadState
    :loading="loading"
    :error="error"
    what="the harnesses, models and prompts"
  >
    <div
      v-if="data"
      class="split config-split"
    >
      <form
        class="grow panel config-form"
        novalidate
        @submit.prevent="save(false)"
      >
        <fieldset class="block-set">
          <legend class="legend">
            Harness
          </legend>
          <p class="hint">
            The agent framework that runs the loop. Each one is an adapter; the settings below show only what it supports.
          </p>
          <div class="tiles">
            <label
              v-for="h in data.harnesses"
              :key="h.name"
              class="tile"
              :class="{ 'tile--on': form.harness === h.name }"
            >
              <span class="tile-head"><input
                v-model="form.harness"
                type="radio"
                name="harness"
                :value="h.name"
                data-test="harness-radio"
              ><span class="strong">{{ harnessName(h.name) }}</span></span>
              <span class="secondary smaller">{{ versionLine(h) }}</span>
              <span
                class="smaller"
                data-test="harness-coverage"
              >{{ coverageText(h) }}</span>
            </label>
          </div>
          <p
            v-if="refusalFor('harness')"
            class="refusal small"
            role="alert"
            data-test="refusal-harness"
          >
            {{ refusalFor('harness')?.message }}<template v-if="refusalFor('harness')?.fix">
              <span class="block"><strong>Fix:</strong> {{ refusalFor('harness')?.fix }}</span>
            </template>
          </p>
        </fieldset>

        <fieldset class="block-set pair">
          <legend class="visually-hidden">
            Model and prompt
          </legend>
          <label class="field">
            <span class="legend">Model</span>
            <span class="hint-inline">Every call goes through LiteLLM with a key made for this trial only.</span>
            <select
              v-model="form.model"
              data-test="model-select"
            >
              <optgroup label="Real models: each call costs money">
                <option
                  v-for="m in modelGroups.real"
                  :key="m.name"
                  :value="m.name"
                >{{ modelName(m.name) }}</option>
              </optgroup>
              <optgroup label="Fake models: scripted replies, free">
                <option
                  v-for="m in modelGroups.fake"
                  :key="m.name"
                  :value="m.name"
                >{{ modelName(m.name) }}: {{ m.does }}</option>
              </optgroup>
            </select>
            <span
              v-if="isFake(form.model)"
              class="secondary smaller"
              data-test="fake-model-note"
            >Fake: the fake LLM server plays a script ({{ fakeDoes(form.model) }}). No real model and no real spend; LiteLLM still counts made-up prices, so budgets and spend work as they would.</span>
            <span
              v-else-if="model"
              class="secondary smaller"
            >Price per million tokens: {{ perMillion(model.input_per_mtok) }} in, {{ perMillion(model.output_per_mtok) }} out, from the LiteLLM config. A real model: each call costs money.</span>
            <span
              v-if="refusalFor('model')"
              class="refusal small"
              role="alert"
              data-test="refusal-model"
            >{{ refusalFor('model')?.message }}<template v-if="refusalFor('model')?.fix"> <strong>Fix:</strong> {{ refusalFor('model')?.fix }}</template></span>
          </label>
          <label class="field">
            <span class="legend">Prompt</span>
            <span class="hint-inline">Versioned files in configs/prompts. A used version is never edited.</span>
            <select
              v-model="form.prompt"
              data-test="prompt-select"
            >
              <option
                v-for="p in taskPrompts"
                :key="p.sha256"
                :value="p.sha256"
              >{{ p.id }} {{ p.version }}</option>
            </select>
            <span
              v-if="refusalFor('prompt')"
              class="refusal small"
              role="alert"
            >{{ refusalFor('prompt')?.message }}<template v-if="refusalFor('prompt')?.fix"> <strong>Fix:</strong> {{ refusalFor('prompt')?.fix }}</template></span>
          </label>
          <div
            v-if="previousPrompt && promptChanges.length"
            class="prompt-diff-toggle smaller"
          >
            <button
              type="button"
              class="link-button"
              :aria-expanded="showPromptDiff"
              @click="showPromptDiff = !showPromptDiff"
            >
              {{ changedLineCount(promptChanges) }} {{ changedLineCount(promptChanges) === 1 ? 'line differs' : 'lines differ' }} from {{ previousPrompt.version }}. {{ showPromptDiff ? 'Hide' : 'View' }} the diff
            </button>
          </div>
          <div
            v-if="showPromptDiff"
            class="line-diff mono"
          >
            <div
              v-for="(c, i) in promptSentences"
              :key="i"
              :class="`line line--${c.side}`"
            >
              <span class="side">{{ c.side === 'a' ? previousPrompt?.version : prompt?.version }}</span> {{ c.text }}
            </div>
          </div>
          <div
            v-if="prompt"
            class="prompt-preview"
            :class="{ 'prompt-preview--open': showPrompt }"
          >
            <div class="prompt-text">
              <p
                v-for="(block, bi) in showPrompt ? promptBlocks : promptBlocks.slice(0, 3)"
                :key="bi"
                :class="`md md--${block.kind}`"
                :style="block.depth ? { paddingLeft: `${block.depth * 18 + 18}px` } : undefined"
              >
                <template
                  v-for="(part, pi) in block.parts"
                  :key="pi"
                >
                  <strong v-if="part.bold">{{ part.text }}</strong>
                  <template v-else>
                    {{ part.text }}
                  </template>
                </template>
              </p>
            </div>
            <button
              type="button"
              class="link-button smaller"
              :aria-expanded="showPrompt"
              @click="showPrompt = !showPrompt"
            >
              {{ showPrompt ? 'Show less' : 'Show the whole prompt' }}
            </button>
          </div>
          <div
            v-if="prompt && !editingPrompt"
            class="prompt-actions"
          >
            <button
              ref="newPromptButton"
              type="button"
              class="btn btn--quiet"
              data-test="new-prompt"
              @click="startPromptEdit"
            >
              New prompt version…
            </button>
            <span class="secondary smaller">Starts from {{ prompt.id }} {{ prompt.version }}; saving writes {{ nextVersion }} beside it and never changes {{ prompt.version }}.</span>
          </div>
          <p
            v-if="promptSaved && !editingPrompt"
            class="small saved"
            role="status"
            data-test="prompt-saved"
          >
            <template v-if="promptSaved.existed">
              That text is already {{ promptSaved.created.id }} {{ promptSaved.created.version }}, so it is picked; nothing was written.
            </template>
            <template v-else>
              Saved as {{ promptSaved.created.id }} {{ promptSaved.created.version }} (<span class="mono">{{ promptSaved.created.path }}</span>) and picked for this config. The file is in the working tree until someone commits it.
            </template>
          </p>
          <div
            v-if="editingPrompt && prompt"
            class="prompt-editor"
            data-test="prompt-editor"
            @keydown.esc.stop.prevent="cancelPromptEdit"
          >
            <label class="field">
              <span class="strong">{{ prompt.id }} {{ nextVersion }}, from {{ prompt.version }}</span>
              <textarea
                v-model="draftText"
                rows="18"
                class="mono prompt-draft"
                spellcheck="true"
                data-test="prompt-draft"
              />
            </label>
            <p
              class="secondary smaller"
              data-test="prompt-draft-lines"
            >
              {{ draftLines ? `${draftLines} ${draftLines === 1 ? 'line differs' : 'lines differ'} from ${prompt.version}.` : `No change from ${prompt.version} yet.` }} A version a run has used is never edited: every change is a new version, so every result keeps pointing at the text it ran.
            </p>
            <p
              v-if="promptRefusal"
              class="refusal small"
              role="alert"
              data-test="prompt-refusal"
            >
              {{ promptRefusal }}
            </p>
            <div class="prompt-actions">
              <button
                type="button"
                class="btn"
                :disabled="promptSaving || !draftLines || !draftText.trim()"
                data-test="save-prompt"
                @click="savePrompt"
              >
                Save as {{ nextVersion }}
              </button>
              <button
                type="button"
                class="btn btn--quiet"
                :disabled="promptSaving"
                data-test="cancel-prompt"
                @click="cancelPromptEdit"
              >
                Cancel
              </button>
              <span class="secondary smaller">Escape cancels too.</span>
            </div>
          </div>
        </fieldset>

        <fieldset class="block-set">
          <legend class="legend">
            Tools
          </legend>
          <p class="hint">
            From the finance MCP server. Every harness receives these exact schemas. A narrower set is a new toolset version, so it shows in the hash.
          </p>
          <label
            v-if="data.toolsets.length > 1"
            class="inline-field toolset-pick"
          >Toolset
            <select v-model="form.toolset">
              <option
                v-for="t in data.toolsets"
                :key="t.sha256"
                :value="t.sha256"
              >{{ t.id }} {{ t.version }}</option>
            </select>
          </label>
          <ul
            class="tools"
            :aria-label="`Tools in ${toolset?.id ?? 'the toolset'}`"
          >
            <li
              v-for="t in tools"
              :key="t"
            >
              <span
                class="tool-check"
                aria-hidden="true"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 20 20"
                ><path
                  d="M4 10.5l4 4 8-9"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                /></svg>
              </span>
              <span class="mono">{{ t }}</span>
            </li>
          </ul>
        </fieldset>

        <fieldset class="block-set">
          <legend class="legend">
            Settings
          </legend>
          <p class="hint">
            What {{ harness ? harnessShort(harness.name) : 'the harness' }} does when a setting is left unset is shown next to it, and so is how the value actually reaches the model.
          </p>
          <!-- Wide: one row per setting, every column fitting. Narrow (a phone, a tablet, the
               form beside the summary): each setting is a block, its columns labelled lines. -->
          <div class="settings-box">
            <table
              class="table settings"
              data-test="settings-table"
            >
              <thead>
                <tr>
                  <th scope="col">
                    Setting
                  </th>
                  <th scope="col">
                    Value
                  </th>
                  <th scope="col">
                    If unset
                  </th>
                  <th scope="col">
                    Reaches the model as
                  </th>
                  <th scope="col">
                    Changes behaviour?
                  </th>
                </tr>
              </thead>
              <tbody>
                <template
                  v-for="name in SETTING_NAMES"
                  :key="name"
                >
                  <tr
                    :data-test="`setting-${name}`"
                    :class="{ 'row--unsupported': !supported(name) || isIgnored(name), 'row--refused': !!refusalFor(name) }"
                  >
                    <th scope="row">
                      <label
                        :for="`setting-${name}`"
                        class="strong"
                      >{{ settingLabel(name) }}</label>
                      <span
                        v-if="settingNote(name) && !isIgnored(name)"
                        class="secondary smaller block"
                      >{{ settingNote(name) }}</span>
                      <span
                        v-if="ignored[name]"
                        class="smaller block ignored-reason"
                        :data-test="`ignored-${name}`"
                      >{{ ignored[name] }}</span>
                    </th>
                    <td class="c-value">
                      <label
                        v-if="BOOLEAN_SETTINGS.includes(name)"
                        class="toggle"
                      >
                        <input
                          :id="`setting-${name}`"
                          v-model="form.toggles[name]"
                          type="checkbox"
                          :disabled="!supported(name) || isIgnored(name)"
                        >
                        <span>{{ !supported(name) || isIgnored(name) ? 'Not available' : form.toggles[name] ? 'On' : 'Off' }}</span>
                      </label>
                      <input
                        v-else
                        :id="`setting-${name}`"
                        v-model="form.numbers[name]"
                        type="text"
                        inputmode="decimal"
                        class="num-input num"
                        :disabled="!supported(name) || isIgnored(name)"
                        :placeholder="supported(name) && !isIgnored(name) ? 'Unset' : 'Not available'"
                        :aria-invalid="refusalFor(name) || problems[name] ? 'true' : undefined"
                        :aria-describedby="refusalFor(name) ? `refusal-${name}` : problems[name] ? `problem-${name}` : undefined"
                      >
                      <span
                        v-if="problems[name]"
                        :id="`problem-${name}`"
                        class="problem smaller"
                        :data-test="`problem-${name}`"
                      >{{ problems[name] }}</span>
                    </td>
                    <td
                      class="secondary"
                      data-label="If unset"
                    >
                      {{ ifUnset(name) }}
                    </td>
                    <td
                      class="c-native"
                      data-label="Reaches the model as"
                    >
                      <span
                        v-if="supported(name) && !isIgnored(name) && harness?.capabilities.settings[name].native"
                        class="mono"
                      >{{ harness?.capabilities.settings[name].native }}</span>
                      <span
                        v-else
                        class="secondary"
                      >–</span>
                    </td>
                    <!-- Each answer looks different, and the words carry it: a check for a change seen,
                       an alert for none seen, plain grey for not checked. -->
                    <td
                      :data-test="`effect-${name}`"
                      data-label="Changes behaviour?"
                    >
                      <span
                        :class="['effect', `effect--${effect(name).kind}`]"
                        :data-effect="effect(name).kind"
                      ><AppIcon
                        v-if="effect(name).kind === 'yes'"
                        name="check"
                        :size="12"
                      /><AppIcon
                        v-else-if="effect(name).kind === 'no'"
                        name="alert"
                        :size="14"
                      />{{ effect(name).text }}</span>
                    </td>
                  </tr>
                  <tr
                    v-if="refusalFor(name)"
                    class="refusal-row"
                  >
                    <td colspan="5">
                      <p
                        :id="`refusal-${name}`"
                        class="refusal small"
                        role="alert"
                        :data-test="`refusal-${name}`"
                      >
                        The API refused {{ settingLabel(name).toLowerCase() }}: {{ refusalFor(name)?.message }}.
                        <span
                          v-if="refusalFor(name)?.fix"
                          class="block"
                          data-test="refusal-fix"
                        ><strong>Fix:</strong> {{ refusalFor(name)?.fix }}</span>
                      </p>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
          <section
            v-if="supported('memory') || supported('skills')"
            class="seeds"
            aria-labelledby="seeds-title"
            data-test="seeds"
          >
            <h3
              id="seeds-title"
              class="seeds-title"
            >
              Seeds
            </h3>
            <p class="hint">
              What every trial of this config starts with: memory entries and skills given by the config, never learned ones. A seed changes the hash.
            </p>
            <template v-if="supported('memory') && !isIgnored('memory')">
              <label
                v-if="form.toggles.memory"
                class="field"
              >
                <span class="strong">Memory, one entry per line</span>
                <textarea
                  v-model="seedMemory"
                  rows="4"
                  data-test="seed-memory"
                  placeholder="Client prefers Hindi terms for loans"
                />
              </label>
              <p
                v-else
                class="secondary small"
              >
                Turn memory on to seed it.
              </p>
            </template>
            <template v-if="supported('skills') && !isIgnored('skills')">
              <div
                v-if="form.toggles.skills"
                class="skills"
              >
                <span class="strong">Skills</span>
                <fieldset
                  v-for="(k, ki) in seedSkills"
                  :key="ki"
                  class="skill"
                  data-test="seed-skill"
                >
                  <legend class="visually-hidden">
                    Skill {{ ki + 1 }}
                  </legend>
                  <label class="field">
                    <span class="smaller">Name: lower-case letters, digits and hyphens</span>
                    <input
                      v-model="k.name"
                      type="text"
                      class="mono"
                      maxlength="64"
                      pattern="[a-z0-9][a-z0-9-]*"
                    >
                  </label>
                  <label class="field">
                    <span class="smaller">Description</span>
                    <input
                      v-model="k.description"
                      type="text"
                      maxlength="300"
                    >
                  </label>
                  <label class="field">
                    <span class="smaller">Body</span>
                    <textarea
                      v-model="k.body"
                      rows="4"
                      class="mono"
                    />
                  </label>
                  <button
                    type="button"
                    class="link-button smaller"
                    @click="removeSkill(ki)"
                  >
                    Remove this skill
                  </button>
                </fieldset>
                <button
                  type="button"
                  class="btn btn--quiet"
                  data-test="add-skill"
                  @click="addSkill"
                >
                  Add a skill
                </button>
              </div>
              <p
                v-else
                class="secondary small"
              >
                Turn skills on to seed them.
              </p>
            </template>
            <p
              v-if="refusalFor('seed')"
              class="refusal small"
              role="alert"
              data-test="refusal-seed"
            >
              {{ refusalFor('seed')?.message }}<template v-if="refusalFor('seed')?.fix">
                <span class="block"><strong>Fix:</strong> {{ refusalFor('seed')?.fix }}</span>
              </template>
            </p>
          </section>
          <details
            v-if="optionProps.length"
            class="options"
          >
            <summary>{{ harness ? harnessShort(harness.name) : 'Harness' }} options ({{ optionProps.length }})</summary>
            <p class="secondary small options-note">
              Options that exist on one harness only live here, not in the shared settings.
            </p>
            <label
              v-for="[k, schema] in optionProps"
              :key="k"
              class="field option"
            >
              <span class="strong">{{ settingLabel(k) }}</span>
              <span
                v-if="schema.description"
                class="secondary smaller"
              >{{ schema.description }}</span>
              <select
                v-if="schema.type === 'boolean'"
                v-model="form.options[k]"
              >
                <option value="">{{ harness ? harnessShort(harness.name) : 'Harness' }} default</option>
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
              <input
                v-else
                v-model="form.options[k]"
                type="text"
              >
            </label>
          </details>
        </fieldset>
      </form>

      <aside
        aria-labelledby="summary"
        class="side stack summary-col"
      >
        <section class="panel panel--pad summary">
          <h2
            id="summary"
            class="section-title"
          >
            This config
          </h2>
          <label class="field">
            <span class="secondary smaller">Name</span>
            <input
              v-model="form.name"
              type="text"
              :maxlength="NAME_MAX"
              data-test="config-name"
              @input="nameTouched = true"
            >
            <span class="secondary smaller">A label for lists: up to {{ NAME_MAX }} characters. It is not part of the config's identity.</span>
          </label>
          <div>
            <span class="secondary smaller block">Content hash</span>
            <span
              v-if="shownHash"
              class="mono hash"
              data-test="config-hash"
            >{{ shortHash(shownHash) }}</span>
            <span
              v-else
              class="hash-pending"
            >Not saved yet</span>
            <span
              class="secondary smaller block"
              data-test="same-as"
            ><template v-if="sameAs && !saved">Same content as “{{ sameAs.name }}”: saving returns that config, under its own name. </template>Changes whenever anything on this page changes.</span>
          </div>
          <div
            v-if="data.configs.length"
            class="divided"
          >
            <label class="field">
              <span class="strong">Compared with</span>
              <select
                v-model="baseHash"
                data-test="base-select"
              >
                <option
                  v-for="c in data.configs"
                  :key="c.hash"
                  :value="c.hash"
                >{{ c.name }} · {{ shortHash(c.hash) }}</option>
              </select>
            </label>
            <ul
              v-if="(apiDiff ? apiDiff.length : changes.length)"
              class="changes"
              data-test="config-changes"
            >
              <template v-if="apiDiff">
                <li
                  v-for="c in apiDiff"
                  :key="c.path"
                >
                  <span class="mono">{{ c.path }}</span>: {{ text(c.a) }} to {{ text(c.b) }}
                </li>
              </template>
              <template v-else>
                <li
                  v-for="c in changes"
                  :key="c"
                >
                  {{ c }}
                </li>
              </template>
            </ul>
            <span class="secondary small block">{{ (apiDiff ? apiDiff.length : changes.length) ? 'Everything else is identical.' : 'Identical to it.' }}</span>
          </div>
          <div
            v-for="w in warnings"
            :key="w.code"
            class="warning small"
            role="note"
            data-test="config-warning"
          >
            <AppIcon
              name="alert"
              :size="16"
            />
            <span>{{ w.message }} <span class="block"><strong>How to avoid it:</strong> {{ w.fix }}</span></span>
          </div>
          <p
            v-if="refusal"
            class="error small"
            role="alert"
            data-test="save-error"
          >
            {{ refusal.field ? `Not saved: the API refused ${refusal.field in ignored || (SETTING_NAMES as readonly string[]).includes(refusal.field) ? settingLabel(refusal.field).toLowerCase() : refusal.field}. See the field for how to fix it.` : refusal.message }}
            <span
              v-if="!refusal.field && refusal.fix"
              class="block"
            ><strong>Fix:</strong> {{ refusal.fix }}</span>
          </p>
          <p
            v-else-if="saved && existed"
            class="small saved"
            role="status"
            data-test="config-exists"
          >
            This config already exists as “{{ saved.name }}” (<span class="mono">{{ shortHash(saved.hash) }}</span>), so nothing new was saved and the name typed here was not used. A name is only a label: the same harness, model, prompt, tools and settings are one config, whatever it is called.
            <a
              :href="href.configPage(saved.hash)"
              data-test="open-saved"
            >Open it</a>
          </p>
          <p
            v-else-if="saved"
            class="small saved"
            role="status"
          >
            Saved as config <span class="mono">{{ shortHash(saved.hash) }}</span>. <a
              :href="href.configPage(saved.hash)"
              data-test="open-saved"
            >Open it</a> to see the rendered prompt and check it for conflicts.
          </p>
          <div class="divided buttons">
            <button
              type="button"
              class="btn"
              :disabled="saving || !!invalid"
              :aria-describedby="invalid ? 'save-blocked' : undefined"
              data-test="save-config"
              @click="save(false)"
            >
              Save config
            </button>
            <button
              type="button"
              class="btn btn--quiet"
              :disabled="saving || !!invalid"
              :aria-describedby="invalid ? 'save-blocked' : undefined"
              data-test="save-and-run"
              @click="save(true)"
            >
              Save and set up a run
            </button>
            <p
              v-if="invalid"
              id="save-blocked"
              class="secondary small"
              data-test="save-blocked"
            >
              {{ invalid }}
            </p>
          </div>
        </section>
        <section
          aria-labelledby="pins"
          class="pins small"
        >
          <h2
            id="pins"
            class="pins-title"
          >
            Pinned so it reproduces
          </h2>
          <dl>
            <dt>{{ harness ? harnessShort(harness.name) : 'Harness' }}</dt>
            <dd class="mono">
              {{ harness ? shortRef(harness.ref) : '–' }}
            </dd>
            <dt>Model</dt>
            <dd class="mono">
              {{ form.model || '–' }}
            </dd>
            <dt>Prompt</dt>
            <dd class="mono">
              {{ prompt ? prompt.path.split('/').pop() : '–' }}
            </dd>
            <dt>Toolset</dt>
            <dd class="mono">
              {{ toolset ? `${toolset.id} ${toolset.version}, ${tools.length} tools` : '–' }}
            </dd>
          </dl>
        </section>
        <section
          aria-labelledby="saved-configs"
          class="panel panel--pad saved-list small"
          data-test="saved-configs"
        >
          <h2
            id="saved-configs"
            class="pins-title"
          >
            Saved configs ({{ data.configs.length }})
          </h2>
          <p class="secondary smaller">
            Open one to see its rendered prompt, check it for conflicts, or fork it.
          </p>
          <ul>
            <li
              v-for="c in [...data.configs].reverse()"
              :key="c.hash"
            >
              <a :href="href.configPage(c.hash)">{{ c.name }}</a>
              <span class="secondary block smaller"><span class="mono">{{ shortHash(c.hash) }}</span> · {{ harnessShort(c.harness) }} · {{ modelName(c.model) }}</span>
            </li>
          </ul>
          <p
            v-if="!data.configs.length"
            class="secondary"
          >
            None yet: save the first one.
          </p>
        </section>
      </aside>
    </div>
  </LoadState>
</template>

<style scoped>
.prompt-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 12px;
}

.prompt-editor {
  margin-top: 12px;
}

.prompt-draft {
  width: 100%;
  font-size: 13px;
  line-height: 1.5;
}

.seeds {
  margin-top: 20px;
  display: grid;
  gap: 10px;
}

.seeds-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.skills {
  display: grid;
  gap: 10px;
}

.skill {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--rule);
  border-radius: 8px;
  display: grid;
  gap: 8px;
}

.refusal {
  display: block;
  margin: 6px 0 0;
  color: var(--error);
}

.refusal strong {
  color: var(--ink);
}

.refusal-row td {
  padding-top: 0;
  border-top: 0;
}

/* Why a typed value cannot be saved, by its field: in words, in the error colour. */
.problem {
  display: block;
  margin-top: 4px;
  max-width: 220px;
  color: var(--error);
}

.ignored-reason {
  margin-top: 2px;
  color: var(--ink-2);
  font-weight: 400;
}

.warning {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--rule-strong);
  border-left: 4px solid var(--warning);
  border-radius: 8px;
}

.saved-list ul {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 8px;
  max-height: 360px;
  overflow-y: auto;
}

.config-split {
  gap: 32px;
}

.config-form {
  padding: 0;
}

.block-set {
  margin: 0;
  padding: 24px 28px;
  border: 0;
  border-bottom: 1px solid var(--rule-soft);
  min-width: 0;
}

.block-set:last-child {
  border-bottom: 0;
}

.legend {
  float: left;
  width: 100%;
  padding: 0;
  margin-bottom: 4px;
  font-size: 18px;
  font-weight: 600;
}

.hint {
  clear: both;
  margin: 0 0 14px;
  color: var(--ink-2);
  font-size: 14px;
}

.hint-inline {
  color: var(--ink-2);
  font-size: 14px;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid var(--rule);
  margin: 1px;
  background: var(--surface);
  cursor: pointer;
  min-height: 44px;
}

.tile--on {
  border: 2px solid var(--ink);
  margin: 0;
}

.tile:focus-within {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.tile-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.strong {
  font-weight: 500;
}

.tile .strong {
  font-weight: 600;
}

.pair {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 20px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field .legend {
  float: none;
  margin: 0;
}

.prompt-diff-toggle,
.line-diff,
.prompt-preview {
  grid-column: 1 / -1;
}

.prompt-diff-toggle {
  margin-top: -12px;
}

.link-button {
  border: 0;
  padding: 0;
  min-height: 44px;
  background: none;
  color: var(--link);
  cursor: pointer;
  text-align: left;
  text-decoration: underline;
  text-decoration-color: var(--rule-strong);
  text-underline-offset: 3px;
}

.link-button:hover {
  text-decoration-color: var(--ink);
}

.line-diff {
  font-size: 13px;
  line-height: 1.6;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.line {
  padding: 6px 10px;
  border-radius: 6px;
}

.line--a {
  background: var(--arm-a-soft);
}

.line--b {
  background: var(--arm-b-soft);
}

.line--a .side {
  color: var(--arm-a-ink);
  font-weight: 500;
}

.line--b .side {
  color: var(--arm-b-ink);
  font-weight: 500;
}

.prompt-preview {
  padding: 16px 18px 6px;
  border-radius: 8px;
  background: var(--ground);
  font-size: 14px;
}

.prompt-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.md--heading {
  font-weight: 600;
  margin-top: 6px;
}

.md--item {
  position: relative;
  padding-left: 18px;
}

.md--item::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0.62em;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ink-2);
}

.md strong {
  font-weight: 600;
}

.tools {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 4px 16px;
}

.tools li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
}

.tool-check {
  display: inline-flex;
  color: var(--ink-2);
}

.toolset-pick {
  margin-bottom: 12px;
}

.settings-box {
  container-type: inline-size;
}

/* Whether a setting changed behaviour: ink with a check when a change was seen (as Probed on
   Harnesses), ink at 500 with an alert when none was, plain grey when not checked. No green. */
.effect {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.effect--yes {
  color: var(--ink);
}

.effect--no {
  color: var(--ink);
  font-weight: 500;
}

.effect--todo,
.effect--na {
  color: var(--ink-2);
}

/* Every column fits: the natives (long call paths) wrap anywhere, the rest between words. */
.settings .mono {
  white-space: normal;
  overflow-wrap: anywhere;
}

.settings tr > :first-child {
  padding-left: 0;
}

.settings tr > :last-child {
  padding-right: 0;
}

.c-native {
  max-width: 260px;
}

@container (max-width: 699px) {
  .settings,
  .settings tbody,
  .settings tr,
  .settings th,
  .settings td {
    display: block;
  }

  .settings thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .settings tbody tr {
    padding: 14px 0;
    border-bottom: 1px solid var(--rule-soft);
  }

  .settings tbody tr:last-child {
    border-bottom: 0;
  }

  .settings tbody tr > *,
  .settings tbody tr > :first-child,
  .settings tbody tr > :last-child {
    padding: 4px 0;
    border-bottom: 0;
  }

  .c-native {
    max-width: none;
  }

  /* Each column a labelled line: its label on the left, its value on the right. */
  .settings td[data-label] {
    display: grid;
    grid-template-columns: 9em minmax(0, 1fr);
    gap: 10px;
  }

  .settings td[data-label]::before {
    content: attr(data-label);
    font-size: 13px;
    color: var(--ink-2);
    padding-top: 1px;
  }

  .refusal-row td {
    padding-top: 0;
  }
}

.row--unsupported th label {
  color: var(--ink-2);
}

.block {
  display: block;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}

.num-input {
  width: 110px;
}

.options {
  margin-top: 18px;
  font-size: 14px;
}

.options > summary {
  cursor: pointer;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-weight: 500;
}

.options-note {
  margin-bottom: 12px;
}

.option {
  max-width: 420px;
}

.summary {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hash {
  font-size: 20px;
  font-weight: 500;
}

.hash-pending {
  display: block;
  font-size: 17px;
  font-weight: 500;
}

.divided {
  border-top: 1px solid var(--rule-soft);
  padding-top: 14px;
}

.changes {
  margin: 8px 0 0;
  padding-left: 18px;
}

.buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.error {
  color: var(--error);
}

.saved {
  color: var(--ink);
}

.pins {
  padding: 0 4px;
}

.pins-title {
  font-size: 15px;
  margin-bottom: 8px;
}

.pins dl {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 16px;
}

.pins dt {
  color: var(--ink-2);
}

.pins dd {
  margin: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .block-set {
    padding: 20px 18px;
  }
}
</style>
