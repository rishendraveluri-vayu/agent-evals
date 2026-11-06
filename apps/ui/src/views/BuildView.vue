<script setup lang="ts">
/**
 * Build an agent, step by step: the guided way to make a config, for a reviewer. One page, five
 * stacked steps, every choice visible and editable: agent type (harness), model, instructions
 * (prompt), the common settings, then save. It makes the same calls as the full Config screen
 * (POST /prompts, POST /configs) and offers only real models; the full screen keeps every setting
 * and the scripted test models.
 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { api } from '../api/client';
import { ApiError, errorWithFix } from '../api/errors';
import type { ConfigView, CreatedPrompt, Harness, Json, ModelView, PromptView, SettingName, ToolsetView } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import InfoTip from '../components/InfoTip.vue';
import LoadState from '../components/LoadState.vue';
import { partial, useLoad } from '../lib/async';
import { autoConfigName, axisChange, axisPhrase, changeWords, type NameContent } from '../lib/checks';
import { baselineFor, missingKey } from '../lib/runSetup';
import { plainText, shortHash, shortRef } from '../lib/format';
import { harnessFacts, harnessTagline, memoryLine } from '../lib/harnessInfo';
import { mdBlocks } from '../lib/markdown';
import { defaultRealModel, isFake, isLocal, LOCAL_MODEL_COMMAND } from '../lib/models';
import { harnessName, harnessShort, modelName, settingLabel } from '../lib/names';
import { NAME_MAX, settingProblem } from '../lib/limits';
import { asRecord, readDraft, writeDraft } from '../lib/sessionDraft';
import { ignoredReasons } from '../lib/settings';
import { href } from '../router';

interface Loaded {
  harnesses: Harness[];
  models: ModelView[];
  /** Why GET /models failed (LiteLLM down, say), in words; null when it answered. The rest of the
   *  page still shows, and the model step says so with a way to try again. */
  modelsProblem: string | null;
  prompts: PromptView[];
  toolsets: ToolsetView[];
  configs: ConfigView[];
}

const { data, error, loading, reload } = useLoad<Loaded>(async () => {
  const [harnesses, models, prompts, toolsets, configs] = await Promise.all([api.harnesses(), partial(api.models(), [] as ModelView[]), api.prompts(), api.toolsets(), api.configs()]);
  return { harnesses, models: models.value, modelsProblem: models.problem, prompts, toolsets, configs };
});

/** Asks for the models again, after GET /models failed; the rest of the form stays as it is. */
const modelsRetrying = ref(false);
async function retryModels() {
  modelsRetrying.value = true;
  try {
    const models = await partial(api.models(), [] as ModelView[]);
    if (data.value) data.value = { ...data.value, models: models.value, modelsProblem: models.problem };
    if (!form.model) form.model = defaultRealModel(realModels.value);
  } finally {
    modelsRetrying.value = false;
  }
}

/** The common settings. Temperature, skills, compression and seeds are on the full Config screen. */
type Shown = 'max_steps' | 'max_output_tokens' | 'timeout_s' | 'parallel_tool_calls' | 'memory';
const NUMBER_SETTINGS: Shown[] = ['max_steps', 'max_output_tokens', 'timeout_s'];
const TOGGLE_SETTINGS: Shown[] = ['parallel_tool_calls', 'memory'];
const SHOWN: Shown[] = [...NUMBER_SETTINGS, ...TOGGLE_SETTINGS];
/** What the API stores for each one left unset (docs/api-contract.md, Configs). */
const DEFAULT_WORDS: Record<Shown, string> = { max_steps: '15', max_output_tokens: '8,192', timeout_s: '300', parallel_tool_calls: 'Off', memory: 'Off' };

/** The key a real model's provider needs in .env (names from .env.example). */
const PROVIDER_KEYS: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

const numbers: Record<string, string> = { max_steps: '', max_output_tokens: '', timeout_s: '' };
const toggles: Record<string, boolean> = { parallel_tool_calls: false, memory: false };
const form = reactive({ harness: '', model: '', prompt: '', name: '', numbers, toggles });
const nameTouched = ref(false);

const versionNumber = (v: string) => Number(/^v(\d+)$/.exec(v)?.[1] ?? 0);
/** Task prompts only, newest version first: the simulator's and the checker's are not an agent's. */
const taskPrompts = computed(() =>
  (data.value?.prompts ?? [])
    .filter((p) => p.id !== 'client-sim' && p.id !== 'conflict-check')
    .sort((a, b) => a.id.localeCompare(b.id) || versionNumber(b.version) - versionNumber(a.version)),
);
/** Real models only: a guided build never offers the scripted test models. */
const realModels = computed(() => (data.value?.models ?? []).filter((m) => !isFake(m.name)));

watch(data, (d) => {
  if (!d || form.harness) return;
  form.harness = d.harnesses[0]?.name ?? '';
  // A hosted model that can run (its key is set) first, else the first hosted one (saving is free
  // without its key); never the local one by default, which runs only once Ollama is up.
  form.model = defaultRealModel(realModels.value);
  form.prompt = taskPrompts.value[0]?.sha256 ?? '';
  restoreKept(d);
});

const harness = computed(() => data.value?.harnesses.find((h) => h.name === form.harness) ?? null);
const model = computed(() => realModels.value.find((m) => m.name === form.model) ?? null);
const prompt = computed(() => data.value?.prompts.find((p) => p.sha256 === form.prompt) ?? null);
/** The first toolset listed that is not for validation (docs/api-contract.md): every agent gets the
 *  same tools. D70's finance-no-calculators is picked only by hand, on the Config screen. */
const toolset = computed(() => data.value?.toolsets.find((t) => !t.validation_only) ?? null);
const promptBlocks = computed(() => (prompt.value ? mdBlocks(prompt.value.text) : []));
const toolCount = computed(() => toolset.value?.servers.reduce((n, s) => n + s.allowed_tools.length, 0) ?? 0);

const perMillion = (v: number | null) => (v === null ? 'not priced' : `$${v.toFixed(2)}`);
const priceLine = (m: ModelView) => {
  if (isLocal(m)) return 'Free: runs on this machine, needs no key';
  return m.input_per_mtok === null && m.output_per_mtok === null ? 'Not priced in the LiteLLM config' : `${perMillion(m.input_per_mtok)} in, ${perMillion(m.output_per_mtok)} out per million tokens`;
};
const keyName = (m: ModelView | null) => (m?.provider ? PROVIDER_KEYS[m.provider] : undefined);

function versionLine(h: Harness): string {
  return /^[0-9a-f]{40}$/.test(h.ref) ? `Pinned at ${shortRef(h.ref)}` : `${h.package} ${h.ref}`;
}

// ---------------------------------------------------------------- settings

const supported = (name: Shown) => harness.value?.capabilities.settings[name]?.supported ?? false;
/** A model's refusals learnt from a 400 this visit, by model: on a fresh database no saved agent
 *  says yet that the model refuses a setting. */
const learnt = reactive<Record<string, Partial<Record<SettingName, string>>>>({});
/** Why a setting cannot be used with this agent type and model, in words; empty when it can. */
const ignored = computed<Partial<Record<SettingName, string>>>(() =>
  harness.value
    ? { ...ignoredReasons(harnessName(harness.value.name), harness.value.capabilities.settings, form.model, data.value?.configs ?? []), ...(learnt[form.model] ?? {}) }
    : {},
);
const usable = (name: Shown) => supported(name) && !ignored.value[name];

function settingInfo(name: Shown): string {
  const extra = harness.value?.capabilities.settings.max_steps?.extra_calls_at_limit;
  switch (name) {
    case 'max_steps':
      return `The most model calls the agent may make in one trial; it stops there. Default 15.${extra ? ` ${harnessShort(form.harness)} may make ${extra} more at the limit.` : ''}`;
    case 'max_output_tokens':
      return 'The most the model may write in one call. Default 8,192.';
    case 'timeout_s':
      return 'The longest one trial may run before it is stopped, in seconds. Default 300.';
    case 'parallel_tool_calls':
      return 'Lets the model ask for several tool calls in one reply. Off by default.';
    case 'memory':
      return 'Gives the agent a memory tool that starts empty; seed it on the full Config screen. Off by default.';
  }
}

/** What the form sets. A number left empty is unset (the API's default applies); parallel tool
 *  calls is sent only when turned on (off is the API's default, so the agent is the same, and a
 *  model that refuses the setting, such as the local Qwen, refuses it even as false); memory is
 *  sent when the agent type takes it; a setting it cannot take is never sent. */
const settings = computed(() => {
  const out: Partial<Record<SettingName, Json>> = {};
  for (const name of SHOWN) {
    if (!usable(name)) continue;
    if (name === 'parallel_tool_calls') {
      if (form.toggles[name] === true) out[name] = true;
    }
    else if (name === 'memory') out[name] = { enabled: form.toggles[name] === true };
    else {
      const raw = form.numbers[name]?.trim();
      if (raw) out[name] = Number(raw);
    }
  }
  return out;
});

// ---------------------------------------------------------------- instructions

const promptMode = ref<'saved' | 'write'>('saved');
const draft = ref('');
/** The prompt the draft started from: saving writes the next version of it. */
const draftBase = ref<PromptView | null>(null);
const promptSaving = ref(false);
const promptError = ref<string | null>(null);
const promptSaved = ref<{ created: CreatedPrompt; existed: boolean } | null>(null);
const draftChanged = computed(() => !!draftBase.value && draft.value.trim() !== '' && draft.value.trim() !== draftBase.value.text.trim());
/** The version POST /prompts will write: the highest v<n> of the prompt plus one. */
const nextVersion = computed(() => {
  const base = draftBase.value;
  if (!base) return '';
  return `v${Math.max(0, ...(data.value?.prompts ?? []).filter((p) => p.id === base.id).map((p) => versionNumber(p.version))) + 1}`;
});

function choosePromptMode(mode: 'saved' | 'write') {
  promptMode.value = mode;
  promptError.value = null;
  if (mode === 'write' && (!draftBase.value || !draftChanged.value)) {
    draftBase.value = prompt.value;
    draft.value = prompt.value?.text ?? '';
  }
}

async function savePrompt() {
  const base = draftBase.value;
  const d = data.value;
  if (!base || !d || !draftChanged.value) return;
  promptSaving.value = true;
  promptError.value = null;
  try {
    const known = new Set(d.prompts.map((p) => p.sha256));
    const created = await api.createPrompt({ id: base.id, base_version: base.version, text: draft.value });
    data.value = { ...d, prompts: await api.prompts() };
    form.prompt = created.sha256;
    promptSaved.value = { created, existed: known.has(created.sha256) };
    promptMode.value = 'saved';
    draftBase.value = null;
  } catch (err) {
    promptError.value = plainText(errorWithFix(err));
  } finally {
    promptSaving.value = false;
  }
}

// ---------------------------------------------------------------- save

/** "Own loop, Claude Haiku 5.5, finance-advisor v1, max steps 12": made from what the agent holds,
 *  as on the full Config screen (lib/checks.ts autoConfigName), so two agents one thing apart never
 *  share a name; a typed name is kept. */
const suggestedName = computed(() =>
  harness.value && model.value && prompt.value ? autoConfigName({ harness: harness.value.name, model: model.value.name, prompt: prompt.value, settings: settings.value as NameContent['settings'] }) : '',
);
watch(suggestedName, (n) => {
  if (!nameTouched.value) form.name = n;
});

/** Why a typed setting cannot be saved, by setting, shown under its field. */
const problems = computed<Partial<Record<Shown, string>>>(() => {
  const out: Partial<Record<Shown, string>> = {};
  for (const name of NUMBER_SETTINGS) {
    const problem = usable(name) ? settingProblem(name, form.numbers[name]) : null;
    if (problem) out[name] = problem;
  }
  return out;
});

/** Why the agent cannot be saved yet, in words; null when it can. */
const blocked = computed<string | null>(() => {
  if (!harness.value) return 'Pick an agent type (step 1).';
  if (!model.value) return data.value?.modelsProblem ? 'The models could not be listed: try again in step 2 once they answer.' : 'Pick a model (step 2).';
  if (promptMode.value === 'write') return 'Save your prompt first, or go back to a saved one (step 3).';
  if (!prompt.value) return 'Pick a prompt (step 3).';
  if (!toolset.value) return 'The API lists no toolset.';
  const problem = NUMBER_SETTINGS.map((name) => problems.value[name]).find(Boolean);
  if (problem) return `Step 4: ${problem}`;
  if (!form.name.trim()) return 'Give the agent a name to save it.';
  return null;
});

const saving = ref(false);
const saveError = ref<string | null>(null);
const saved = ref<{ config: ConfigView; existed: boolean } | null>(null);
/** A save of the agent or of a prompt is on its way: every step is locked until it answers, so
 *  the saved panel always describes what was sent, never a choice changed in the meantime. */
const busy = computed(() => saving.value || promptSaving.value);

async function save() {
  const d = data.value;
  if (busy.value || blocked.value || !d || !toolset.value) return;
  saving.value = true;
  saveError.value = null;
  // What is sent, read once.
  const name = form.name.trim();
  const model = form.model;
  try {
    const known = new Set(d.configs.map((c) => c.hash));
    const config = await api.createConfig({
      name,
      harness: form.harness,
      model,
      prompt_sha256: form.prompt,
      toolset_sha256: toolset.value.sha256,
      settings: settings.value,
    });
    const configs = await api.configs();
    data.value = { ...(data.value ?? d), configs };
    // The API returns the stored agent when this content exists already, under the name it was
    // first saved with; the name typed here is not used.
    saved.value = { config, existed: known.has(config.hash) || config.name !== name };
  } catch (err) {
    saveError.value = plainText(errorWithFix(err));
    // A model's refusal holds for every agent on that model: grey the setting from now on, so the
    // next save leaves it out (the full Config screen does the same).
    if (err instanceof ApiError && err.code === 'unsupported_setting' && err.message.includes(model)) {
      const named = SHOWN.find((n) => new RegExp(`\\b${n}\\b`).test(err.message));
      if (named && supported(named)) learnt[model] = { ...(learnt[model] ?? {}), [named]: plainText(err.fix ?? err.message) };
    }
  } finally {
    saving.value = false;
  }
}

// Any change after saving is a different agent: the saved panel goes until it is saved again.
// The source is the choices themselves, as a string, so reloading the configs after a save, or
// learning a model's refusal from one (whose error should stay in view), is no change.
watch(
  () => JSON.stringify([form.harness, form.model, form.prompt, form.numbers, form.toggles]),
  () => {
    saved.value = null;
    saveError.value = null;
  },
);

// ---------------------------------------------------------------- next steps

/** The baseline to compare this agent with: a saved agent of your own that differs from it in
 *  exactly one thing (the Run screen's own rule, baselineFor), never a shipped example's. */
const baseline = computed<{ config: ConfigView; axis: string } | null>(() => {
  const mine = saved.value?.config;
  return mine ? baselineFor(data.value?.configs ?? [], mine.hash) : null;
});

/** The baseline is a fork of this agent: then this agent is the baseline (arm A) and the fork the
 *  change being tried (arm B), as the fork's own "Save and set up a run" sets it up. */
const baselineIsFork = computed(() => !!saved.value && baseline.value?.config.parent_hash === saved.value.config.hash);
/** What the two agents differ in, with both values, arm A's first: "Claude Haiku 5.5 vs Claude Sonnet 5.5". */
const baselineChange = computed(() => {
  const mine = saved.value?.config;
  const other = baseline.value?.config;
  if (!mine || !other) return '';
  const [a, b] = baselineIsFork.value ? [mine, other] : [other, mine];
  const one = axisChange(a, b);
  return one ? changeWords(one) : '';
});

/** Arm A is the baseline and arm B the agent being tried: the comparison reads B minus A. With no
 *  baseline, the Run screen runs this agent on its own (a pilot) and says how to make one. */
const runLink = computed(() => {
  const mine = saved.value?.config;
  if (!mine) return href.runNew();
  if (baselineIsFork.value && baseline.value) return href.runNew(mine.hash, baseline.value.config.hash);
  return href.runNew(baseline.value?.config.hash, mine.hash);
});

// ---------------------------------------------------------------- provider keys

/** The .env variable the picked model needs and lacks; null when it is set or not known. */
const keyMissing = computed(() => missingKey(form.model, data.value?.models ?? []));
/** No provider key is known to be set: no listed model has `key_set: true`. A model whose key is
 *  unknown (`null`, such as the local Qwen, which needs none but runs only with its compose
 *  profile) does not count as runnable. A keyless reviewer is pointed at the free route. */
const noKeys = computed(() => realModels.value.length > 0 && !realModels.value.some((m) => m.key_set === true));
/** The local open-weight model, when LiteLLM lists it: it needs no key, only its compose profile. */
const localModel = computed(() => realModels.value.find((m) => isLocal(m)) ?? null);

// ---------------------------------------------------------------- kept across navigation

/** This tab's choices, a prompt being written included, so a link away (the i's Harnesses page,
 *  the preview) and Back find the form as it was. */
const KEEP_KEY = 'agent-evals-build';

/** Puts back what this tab last had, choice by choice: one that no longer exists (a prompt or a
 *  model gone from the lists) keeps its default. */
function restoreKept(d: Loaded): void {
  const kept = asRecord(readDraft(KEEP_KEY));
  if (!kept) return;
  const text = (k: string) => {
    const v = kept[k];
    return typeof v === 'string' ? v : null;
  };
  const keptHarness = text('harness');
  if (keptHarness && d.harnesses.some((h) => h.name === keptHarness)) form.harness = keptHarness;
  const keptModel = text('model');
  if (keptModel && realModels.value.some((m) => m.name === keptModel)) form.model = keptModel;
  const keptPrompt = text('prompt');
  if (keptPrompt && taskPrompts.value.some((p) => p.sha256 === keptPrompt)) form.prompt = keptPrompt;
  const numbersKept = asRecord(kept.numbers) ?? {};
  for (const name of NUMBER_SETTINGS) {
    const v = numbersKept[name];
    if (typeof v === 'string') form.numbers[name] = v;
  }
  const togglesKept = asRecord(kept.toggles) ?? {};
  for (const name of TOGGLE_SETTINGS) {
    const v = togglesKept[name];
    if (typeof v === 'boolean') form.toggles[name] = v;
  }
  const keptName = text('name');
  if (kept.nameTouched === true && keptName !== null) {
    nameTouched.value = true;
    form.name = keptName;
  }
  const base = d.prompts.find((p) => p.sha256 === text('draftBase'));
  if (kept.promptMode === 'write' && base) {
    draftBase.value = base;
    draft.value = text('draft') ?? base.text;
    promptMode.value = 'write';
  }
  const savedHash = text('saved');
  const config = savedHash ? d.configs.find((c) => c.hash === savedHash) : undefined;
  // After the choices above settle: setting them clears the saved panel (a change is a new agent).
  if (config) {
    void nextTick(() => {
      saved.value = { config, existed: kept.savedExisted === true };
    });
  }
}

const kept = computed(() => ({
  harness: form.harness,
  model: form.model,
  prompt: form.prompt,
  name: form.name,
  nameTouched: nameTouched.value,
  numbers: { ...form.numbers },
  toggles: { ...form.toggles },
  promptMode: promptMode.value,
  draft: draft.value,
  draftBase: draftBase.value?.sha256 ?? null,
  saved: saved.value?.config.hash ?? null,
  savedExisted: saved.value?.existed ?? false,
}));
watch(kept, (value) => {
  if (data.value && form.harness) writeDraft(KEEP_KEY, value);
});
</script>

<template>
  <div class="page-head">
    <nav
      aria-label="Breadcrumb"
      class="crumbs"
    >
      <a :href="href.start()">Start</a> / Build an agent
    </nav>
    <h1 tabindex="-1">
      Build an agent
    </h1>
    <p class="lede">
      Pick an agent type, a model and its instructions, then save it. Saving gives the agent a content hash, so every result points back to exactly this agent. Then preview what reaches the model and evaluate it against a baseline.
    </p>
  </div>

  <LoadState
    :loading="loading"
    :error="error"
    :retry="reload"
    what="the agent types, models and prompts"
  >
    <form
      v-if="data"
      class="panel build"
      novalidate
      data-test="build-form"
      @submit.prevent="save"
    >
      <!-- 1. Agent type -->
      <fieldset
        class="step"
        :disabled="busy"
      >
        <legend class="step-title">
          <span
            class="step-n"
            aria-hidden="true"
          >1</span>Agent type
        </legend>
        <p class="hint">
          The framework that runs the tool loop. Every type gets the same tools and the same prompt; they differ in what they add around them. The i on each says how.
        </p>
        <div class="tiles">
          <div
            v-for="h in data.harnesses"
            :key="h.name"
            class="tile"
            :class="{ 'tile--on': form.harness === h.name }"
            :data-test="`harness-${h.name}`"
          >
            <label class="tile-main">
              <span class="tile-head"><input
                v-model="form.harness"
                type="radio"
                name="build-harness"
                :value="h.name"
                data-test="harness-radio"
              ><span class="tile-name">{{ harnessName(h.name) }}</span></span>
              <span class="small">{{ harnessTagline(h) }}</span>
              <span class="secondary smaller">{{ versionLine(h) }}</span>
            </label>
            <InfoTip
              class="tile-info"
              :label="`About ${harnessName(h.name)}`"
            >
              <p class="note-what">
                {{ harnessFacts(h.name)?.what ?? `${h.package} ${h.ref}` }}
              </p>
              <dl
                v-if="harnessFacts(h.name)"
                class="note-facts"
              >
                <dt>Tool loop</dt>
                <dd>{{ harnessFacts(h.name)?.loop }}</dd>
                <dt>Adds to your prompt</dt>
                <dd>{{ harnessFacts(h.name)?.prompt }}</dd>
                <dt>Memory</dt>
                <dd data-test="note-memory">
                  {{ memoryLine(h.capabilities.settings) }}
                </dd>
                <dt>Pick it</dt>
                <dd>{{ harnessFacts(h.name)?.pick }}</dd>
              </dl>
              <p
                v-else
                class="secondary"
              >
                Memory: {{ memoryLine(h.capabilities.settings) }}
              </p>
              <a
                :href="href.harnesses()"
                class="note-more smaller"
              >Every known difference, on the Harnesses page</a>
            </InfoTip>
          </div>
        </div>
      </fieldset>

      <!-- 2. Model -->
      <fieldset
        class="step"
        :disabled="busy"
      >
        <legend class="step-title">
          <span
            class="step-n"
            aria-hidden="true"
          >2</span>Model
        </legend>
        <p class="hint">
          The model the agent calls. Every call goes through LiteLLM, with a key made for that trial only.
        </p>
        <div
          v-if="realModels.length"
          class="tiles"
        >
          <label
            v-for="m in realModels"
            :key="m.name"
            class="tile tile-main"
            :class="{ 'tile--on': form.model === m.name }"
            :data-test="`model-${m.name}`"
          >
            <span class="tile-head"><input
              v-model="form.model"
              type="radio"
              name="build-model"
              :value="m.name"
              data-test="model-radio"
            ><span class="tile-name">{{ modelName(m.name) }}</span></span>
            <span class="secondary smaller num">{{ priceLine(m) }}</span>
            <span
              v-if="missingKey(m.name, realModels)"
              class="smaller needs-key"
              data-test="needs-key"
            >needs {{ missingKey(m.name, realModels) }} in .env</span>
          </label>
        </div>
        <div
          v-if="data.modelsProblem"
          class="models-problem small"
          role="alert"
          data-test="models-problem"
        >
          <span>The models could not be listed, so none can be picked yet: {{ plainText(data.modelsProblem) }} The other steps work meanwhile.</span>
          <button
            type="button"
            class="btn btn--quiet"
            :disabled="modelsRetrying"
            data-test="models-retry"
            @click="retryModels"
          >
            Try again
          </button>
        </div>
        <p
          v-else-if="noKeys"
          class="small no-keys"
          role="note"
          data-test="no-keys"
        >
          No provider key is set in <span class="mono">.env</span>, so no hosted model can run yet. You can still build and save an agent here, and preview what reaches the model, for free.<template v-if="localModel">
            The local model, {{ modelName(localModel.name) }}, needs no key, but it runs only once its compose profile is up (see the README, Add a model), and slowly on a CPU.
          </template> Fake models run without a key, from the <a :href="href.config()">full Config screen</a>, but they make the same scripted calls whatever the task, so most trials fail: they exist to test the platform, not to judge an agent.
        </p>
        <p
          v-else-if="!realModels.length"
          class="secondary"
          data-test="no-models"
        >
          No real models are set up in LiteLLM yet (services/litellm/config.yaml), so there is nothing to pick here. The <a :href="href.config()">full Config screen</a> lists every model LiteLLM serves.
        </p>
        <p
          v-if="model"
          class="cost-note small"
          role="note"
          data-test="model-cost-note"
        >
          <AppIcon
            name="alert"
            :size="16"
          />
          <span
            v-if="isLocal(model)"
            data-test="local-model-note"
          >{{ modelName(model.name) }} runs on this machine, through Ollama: it costs nothing per token and needs no key. It answers only once its compose profile is up (<span class="mono">{{ LOCAL_MODEL_COMMAND }}</span>, then pull the model once; see the README, Add a model), and slowly on a CPU, so it suits a smoke check, not an experiment. Saving costs nothing; the Run screen shows the trials and models before anything starts.</span>
          <span v-else-if="keyMissing"><span class="mono">{{ keyMissing }}</span> is not set in <span class="mono">.env</span>, so this model cannot run yet. Saving is free and works anyway; before a run, add the key, then run <span class="mono">docker compose up -d</span>. A run calls a real model, so it costs money: the Run screen shows the trials, models and cost before anything starts.</span>
          <span v-else>Running this agent calls a real model, so it costs money and needs <template v-if="keyName(model)">the provider's key, <span class="mono">{{ keyName(model) }}</span>,</template><template v-else>the provider's API key</template> in <span class="mono">.env</span>. Saving costs nothing; the Run screen shows the trials, models and cost before anything starts.</span>
        </p>
      </fieldset>

      <!-- 3. Instructions -->
      <fieldset
        class="step"
        :disabled="busy"
      >
        <legend class="step-title">
          <span
            class="step-n"
            aria-hidden="true"
          >3</span>Instructions
        </legend>
        <p class="hint">
          The system prompt: what the agent is told to do. Prompts are versioned files, and a saved version is never changed.
        </p>
        <div
          class="seg prompt-seg"
          role="group"
          aria-label="Where the prompt comes from"
        >
          <button
            type="button"
            :aria-pressed="promptMode === 'saved'"
            data-test="prompt-mode-saved"
            @click="choosePromptMode('saved')"
          >
            Use a saved prompt
          </button>
          <button
            type="button"
            :aria-pressed="promptMode === 'write'"
            :disabled="!prompt"
            data-test="prompt-mode-write"
            @click="choosePromptMode('write')"
          >
            Write your own
          </button>
        </div>

        <template v-if="promptMode === 'saved'">
          <label class="field prompt-pick">
            <span class="strong">Prompt</span>
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
          </label>
          <p
            v-if="promptSaved"
            class="small saved-line"
            role="status"
            data-test="prompt-saved"
          >
            <template v-if="promptSaved.existed">
              That text is already {{ promptSaved.created.id }} {{ promptSaved.created.version }}, so it is picked; nothing new was written.
            </template>
            <template v-else>
              Saved as {{ promptSaved.created.id }} {{ promptSaved.created.version }} and picked for this agent.
            </template>
          </p>
          <div
            v-if="prompt"
            class="prompt-box"
          >
            <span class="secondary smaller block">The text the agent gets, {{ prompt.id }} {{ prompt.version }}</span>
            <div
              class="prompt-text"
              data-test="prompt-text"
            >
              <p
                v-for="(block, bi) in promptBlocks"
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
          </div>
        </template>

        <div
          v-else-if="draftBase"
          class="prompt-editor"
          data-test="prompt-editor"
        >
          <label class="field">
            <span class="strong">Your prompt, from {{ draftBase.id }} {{ draftBase.version }}</span>
            <textarea
              v-model="draft"
              rows="14"
              class="prompt-draft"
              spellcheck="true"
              data-test="prompt-draft"
            />
          </label>
          <p class="secondary smaller">
            Saving writes it as {{ draftBase.id }} {{ nextVersion }}, beside {{ draftBase.version }}, which stays as it is. A prompt keeps its name across versions.
          </p>
          <p
            v-if="promptError"
            class="error small"
            role="alert"
            data-test="prompt-error"
          >
            {{ promptError }}
          </p>
          <div class="actions">
            <button
              type="button"
              class="btn"
              :disabled="promptSaving || !draftChanged"
              data-test="save-prompt"
              @click="savePrompt"
            >
              Save prompt as {{ nextVersion }}
            </button>
            <span
              v-if="!draftChanged"
              class="secondary smaller"
            >No change from {{ draftBase.version }} yet.</span>
          </div>
        </div>
      </fieldset>

      <!-- 4. Settings -->
      <fieldset
        class="step"
        :disabled="busy"
      >
        <legend class="step-title">
          <span
            class="step-n"
            aria-hidden="true"
          >4</span>Settings
        </legend>
        <p class="hint">
          The common ones. Leave a number empty for the default. A setting {{ harness ? harnessShort(harness.name) : 'this agent type' }} cannot use is greyed out, with the reason.
        </p>
        <div class="settings">
          <div
            v-for="name in SHOWN"
            :key="name"
            class="setting"
            :class="{ 'setting--off': !usable(name) }"
            :data-test="`setting-${name}`"
          >
            <div class="setting-head">
              <label
                :for="`build-${name}`"
                class="strong"
              >{{ settingLabel(name) }}</label>
              <InfoTip :label="`About ${settingLabel(name).toLowerCase()}`">
                <p>{{ settingInfo(name) }}</p>
              </InfoTip>
            </div>
            <template v-if="NUMBER_SETTINGS.includes(name)">
              <input
                :id="`build-${name}`"
                v-model="form.numbers[name]"
                type="text"
                inputmode="numeric"
                class="num num-input"
                :placeholder="usable(name) ? `${DEFAULT_WORDS[name]} (default)` : 'Not available'"
                :disabled="!usable(name)"
                :aria-invalid="problems[name] ? 'true' : undefined"
                :aria-describedby="problems[name] ? `build-problem-${name}` : undefined"
              >
              <span
                v-if="problems[name]"
                :id="`build-problem-${name}`"
                class="smaller problem"
                :data-test="`problem-${name}`"
              >{{ problems[name] }}</span>
            </template>
            <label
              v-else
              class="toggle"
            >
              <input
                :id="`build-${name}`"
                v-model="form.toggles[name]"
                type="checkbox"
                :disabled="!usable(name)"
              >
              <span>{{ !usable(name) ? 'Not available' : form.toggles[name] ? 'On' : 'Off' }}</span>
            </label>
            <span
              v-if="ignored[name]"
              class="smaller reason"
              :data-test="`reason-${name}`"
            >{{ ignored[name] }}</span>
          </div>
        </div>
        <p class="small all-settings">
          <a
            :href="saved ? href.fork(saved.config.hash) : href.config()"
            data-test="all-settings"
          >All settings</a>
          <span class="secondary">{{ saved ? ': opens this agent on the full Config screen, with temperature, skills, seeds and harness options.' : ': temperature, skills, seeds and harness options, on the full Config screen. Save first to carry these choices over.' }}</span>
        </p>
      </fieldset>

      <!-- 5. Save -->
      <fieldset
        class="step"
        :disabled="busy"
      >
        <legend class="step-title">
          <span
            class="step-n"
            aria-hidden="true"
          >5</span>Save
        </legend>
        <ul
          class="summary small"
          data-test="build-summary"
        >
          <li><span class="secondary">Agent type</span> {{ harness ? harnessName(harness.name) : '–' }}</li>
          <li><span class="secondary">Model</span> {{ model ? modelName(model.name) : '–' }}</li>
          <li><span class="secondary">Prompt</span> {{ prompt && promptMode === 'saved' ? `${prompt.id} ${prompt.version}` : 'not saved yet' }}</li>
          <li><span class="secondary">Tools</span> {{ toolset ? `${toolCount} ${toolset.servers.map((s) => s.name).join(' and ')} tools, the same for every agent type` : '–' }}</li>
        </ul>
        <label class="field name-field">
          <span class="strong">Name</span>
          <input
            v-model="form.name"
            type="text"
            :maxlength="NAME_MAX"
            data-test="agent-name"
            @input="nameTouched = true"
          >
          <span class="secondary smaller">A label for lists, up to {{ NAME_MAX }} characters. It is not part of the agent's identity: the same choices are one agent, whatever it is called.</span>
        </label>
        <p
          v-if="saveError"
          class="error small"
          role="alert"
          data-test="save-error"
        >
          Not saved: {{ saveError }}
        </p>
        <p
          v-else-if="blocked"
          id="build-save-blocked"
          class="secondary small blocked"
          data-test="save-blocked"
        >
          {{ blocked }}
        </p>
        <div class="actions">
          <button
            type="submit"
            class="btn"
            :disabled="saving || !!blocked"
            :aria-describedby="blocked ? 'build-save-blocked' : undefined"
            data-test="save-agent"
          >
            Save agent
          </button>
        </div>

        <section
          v-if="saved"
          class="next"
          aria-labelledby="next-title"
          data-test="next-steps"
        >
          <p
            class="small"
            role="status"
            data-test="saved-status"
          >
            <template v-if="saved.existed">
              This agent already exists as “{{ saved.config.name }}” (<span class="mono">{{ shortHash(saved.config.hash) }}</span>), so nothing new was saved and the name typed here was not used. A name is only a label: the same agent type, model, prompt and settings are one agent, whatever it is called.
            </template>
            <template v-else>
              Saved as {{ saved.config.name }}, <span class="mono">{{ shortHash(saved.config.hash) }}</span>.
            </template>
          </p>
          <div
            v-for="w in saved.config.warnings ?? []"
            :key="w.code"
            class="warning small"
            role="note"
            data-test="saved-warning"
          >
            <AppIcon
              name="alert"
              :size="16"
            />
            <span>{{ w.message }} <span class="block"><strong>How to avoid it:</strong> {{ w.fix }}</span></span>
          </div>
          <h2
            id="next-title"
            class="next-title"
          >
            Next
          </h2>
          <ol class="next-list">
            <li>
              <a
                :href="href.configPage(saved.config.hash)"
                class="next-link"
                data-test="next-preview"
              >See what reaches the model</a>
              <span class="secondary small block">A free preview of exactly what the model receives: the harness's own text, with your prompt marked inside it.</span>
            </li>
            <li v-if="baseline">
              <a
                :href="runLink"
                class="next-link"
                data-test="next-evaluate"
              >Evaluate it</a>
              <span
                class="secondary small block"
                data-test="next-evaluate-words"
              >
                <template v-if="baselineIsFork">
                  Against {{ baseline.config.name }}, a fork of this agent that differs from it only in {{ axisPhrase(baseline.axis) }}{{ baselineChange ? ` (${baselineChange})` : '' }}: this agent is arm A, the baseline, and the fork arm B, the change being tried.
                </template>
                <template v-else>
                  Against {{ baseline.config.name }}, which differs from it only in {{ axisPhrase(baseline.axis) }}{{ baselineChange ? ` (${baselineChange})` : '' }}: that agent is arm A, the baseline, and this one arm B, the agent being tried.
                </template>
                The Run screen shows the trials, models and cost before anything starts.
              </span>
            </li>
            <li v-else>
              <a
                :href="href.fork(saved.config.hash)"
                class="next-link"
                data-test="next-fork"
              >Fork it to try one change</a>
              <span
                class="secondary small block"
                data-test="next-evaluate-words"
              >
                A comparison needs two agents that differ in just one thing, so any difference in results comes from that one change. None differs from this one that way yet. Fork it, change one setting, the prompt or the model, and press Save and set up a run: this agent is then arm A, the baseline, and the fork arm B, the change being tried.
                Or <a
                  :href="runLink"
                  data-test="next-evaluate"
                >run this agent on its own</a> (a pilot) to see how it does.
              </span>
            </li>
          </ol>
        </section>
      </fieldset>
    </form>
  </LoadState>
</template>

<style scoped>
.build {
  padding: 0;
}

.step {
  margin: 0;
  padding: 24px 28px;
  border: 0;
  border-bottom: 1px solid var(--rule-soft);
  min-width: 0;
}

.step:last-child {
  border-bottom: 0;
}

.step-title {
  float: left;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  margin-bottom: 4px;
  font-size: 18px;
  font-weight: 600;
}

/* The step number, as on the Harnesses page's "Add a harness" steps. */
.step-n {
  display: inline-flex;
  flex: none;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1.5px solid var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.hint {
  clear: both;
  margin: 0 0 14px;
  color: var(--ink-2);
  font-size: 14px;
  max-width: 72ch;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.tile {
  position: relative;
  border-radius: 10px;
  border: 1px solid var(--rule);
  margin: 1px;
  background: var(--surface);
  min-width: 0;
}

.tile--on {
  border: 2px solid var(--ink);
  margin: 0;
}

.tile:focus-within {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.tile-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 44px;
  padding: 14px 16px;
  cursor: pointer;
}

/* Room on the right for the i button. */
.tile .tile-main {
  padding-right: 48px;
}

.tile-info {
  position: absolute;
  top: 14px;
  right: 16px;
}

.tile-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tile-name {
  font-weight: 600;
}

.note-what {
  margin-bottom: 8px;
}

.note-facts {
  margin: 0;
}

/* Each label runs into its line ("Tool loop. Model, then ..."), so a note stays short. */
.note-facts dt {
  display: inline;
  margin-right: 0.3em;
  font-weight: 600;
}

.note-facts dt::after {
  content: '.';
}

.note-facts dd {
  display: inline;
  margin: 0;
}

.note-facts dd::after {
  content: '';
  display: block;
  margin-bottom: 6px;
}

.note-more {
  display: inline-block;
  margin-top: 4px;
}

.cost-note {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--rule-strong);
  border-left: 4px solid var(--warning);
  border-radius: 8px;
  max-width: 72ch;
}

.cost-note .icon {
  margin-top: 2px;
}

/* A model whose provider key is not in .env: said on its tile, in words, not by colour alone. */
.needs-key {
  font-weight: 600;
  color: var(--ink);
}

.models-problem {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin: 12px 0 0;
  max-width: 72ch;
  color: var(--error);
}

.models-problem > span {
  flex: 1 1 260px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.no-keys {
  margin: 12px 0 0;
  max-width: 72ch;
}

.prompt-seg {
  display: inline-flex;
  margin-bottom: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.prompt-pick {
  max-width: 420px;
}

.strong {
  font-weight: 500;
}

.block {
  display: block;
}

.saved-line {
  margin-top: 10px;
}

.prompt-box {
  margin-top: 14px;
  padding: 14px 16px;
  border-radius: 8px;
  background: var(--ground);
}

/* The prompt as the full Config screen shows it: headings, bullets and bold, in a box that
   scrolls past 320 px. */
.prompt-text {
  margin-top: 6px;
  max-height: 320px;
  overflow-y: auto;
  overflow-wrap: anywhere;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
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

.prompt-editor {
  display: grid;
  gap: 10px;
}

.prompt-draft {
  width: 100%;
  font-size: 14px;
  line-height: 1.5;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.settings {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px 20px;
}

.setting {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.setting-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
}

.setting--off .setting-head label {
  color: var(--ink-2);
}

.num-input {
  width: 100%;
  max-width: 200px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
}

.reason {
  color: var(--ink-2);
}

.problem {
  color: var(--error);
}

.all-settings {
  margin-top: 18px;
}

.summary {
  clear: both;
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: grid;
  gap: 4px;
}

.summary li {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 8px;
}

.name-field {
  max-width: 520px;
  margin-bottom: 12px;
}

.error {
  color: var(--error);
  margin-bottom: 10px;
}

.blocked {
  margin-bottom: 10px;
}

.next {
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--rule-soft);
  display: grid;
  gap: 12px;
}

.next-title {
  font-size: 16px;
}

.next-list {
  margin: 0;
  padding-left: 22px;
  display: grid;
  gap: 12px;
}

.next-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-weight: 600;
}

.next-list li {
  line-height: 1.4;
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

@media (max-width: 640px) {
  .step {
    padding: 20px 16px;
  }

  .prompt-seg {
    display: flex;
  }

  .prompt-seg button {
    flex: 1 1 auto;
  }
}
</style>
