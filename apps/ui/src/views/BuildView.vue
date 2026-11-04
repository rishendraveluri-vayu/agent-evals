<script setup lang="ts">
/**
 * Build an agent, step by step: the guided way to make a config, for a reviewer. One page, five
 * stacked steps, every choice visible and editable: agent type (harness), model, instructions
 * (prompt), the common settings, then save. It makes the same calls as the full Config screen
 * (POST /prompts, POST /configs) and offers only real models; the full screen keeps every setting
 * and the scripted test models.
 */
import { computed, reactive, ref, watch } from 'vue';
import { api } from '../api/client';
import { errorWithFix } from '../api/errors';
import type { ConfigDiffEntry, ConfigView, CreatedPrompt, Harness, Json, ModelView, PromptView, SettingName, ToolsetView } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import InfoTip from '../components/InfoTip.vue';
import LoadState from '../components/LoadState.vue';
import { useLoad } from '../lib/async';
import { axisFromDiff, axisPhrase } from '../lib/checks';
import { shortHash, shortRef } from '../lib/format';
import { harnessFacts, harnessTagline, memoryLine } from '../lib/harnessInfo';
import { mdBlocks } from '../lib/markdown';
import { isFake } from '../lib/models';
import { harnessName, harnessShort, modelName, settingLabel } from '../lib/names';
import { ignoredReasons } from '../lib/settings';
import { href } from '../router';

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
  form.model = realModels.value[0]?.name ?? '';
  form.prompt = taskPrompts.value[0]?.sha256 ?? '';
});

const harness = computed(() => data.value?.harnesses.find((h) => h.name === form.harness) ?? null);
const model = computed(() => realModels.value.find((m) => m.name === form.model) ?? null);
const prompt = computed(() => data.value?.prompts.find((p) => p.sha256 === form.prompt) ?? null);
/** One built-in toolset until more exist (docs/api-contract.md): every agent gets the same tools. */
const toolset = computed(() => data.value?.toolsets[0] ?? null);
const promptBlocks = computed(() => (prompt.value ? mdBlocks(prompt.value.text) : []));
const toolCount = computed(() => toolset.value?.servers.reduce((n, s) => n + s.allowed_tools.length, 0) ?? 0);

const perMillion = (v: number | null) => (v === null ? 'not priced' : `$${v.toFixed(2)}`);
const priceLine = (m: ModelView) =>
  m.input_per_mtok === null && m.output_per_mtok === null ? 'Not priced in the LiteLLM config' : `${perMillion(m.input_per_mtok)} in, ${perMillion(m.output_per_mtok)} out per million tokens`;
const keyName = (m: ModelView | null) => (m?.provider ? PROVIDER_KEYS[m.provider] : undefined);

function versionLine(h: Harness): string {
  return /^[0-9a-f]{40}$/.test(h.ref) ? `Pinned at ${shortRef(h.ref)}` : `${h.package} ${h.ref}`;
}

// ---------------------------------------------------------------- settings

const supported = (name: Shown) => harness.value?.capabilities.settings[name]?.supported ?? false;
/** Why a setting cannot be used with this agent type and model, in words; empty when it can. */
const ignored = computed<Partial<Record<SettingName, string>>>(() =>
  harness.value ? ignoredReasons(harnessName(harness.value.name), harness.value.capabilities.settings, form.model, data.value?.configs ?? []) : {},
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

/** What the form sets. A number left empty is unset (the API's default applies); a toggle is
 *  sent when the agent type takes it; a setting it cannot take is never sent. */
const settings = computed(() => {
  const out: Partial<Record<SettingName, Json>> = {};
  for (const name of SHOWN) {
    if (!usable(name)) continue;
    if (name === 'parallel_tool_calls') out[name] = form.toggles[name] === true;
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
    promptError.value = errorWithFix(err);
  } finally {
    promptSaving.value = false;
  }
}

// ---------------------------------------------------------------- save

const suggestedName = computed(() => (harness.value && model.value && prompt.value ? `${harnessShort(harness.value.name)}, ${modelName(model.value.name)}, ${prompt.value.id} ${prompt.value.version}` : ''));
watch(suggestedName, (n) => {
  if (!nameTouched.value) form.name = n;
});

/** Why the agent cannot be saved yet, in words; null when it can. */
const blocked = computed<string | null>(() => {
  if (!harness.value) return 'Pick an agent type (step 1).';
  if (!model.value) return 'Pick a model (step 2).';
  if (promptMode.value === 'write') return 'Save your prompt first, or go back to a saved one (step 3).';
  if (!prompt.value) return 'Pick a prompt (step 3).';
  if (!toolset.value) return 'The API lists no toolset.';
  for (const name of NUMBER_SETTINGS) {
    const raw = form.numbers[name]?.trim();
    if (usable(name) && raw && !(Number.isFinite(Number(raw)) && Number(raw) > 0)) return `${settingLabel(name)} must be a number above 0 (step 4).`;
  }
  if (!form.name.trim()) return 'Give the agent a name.';
  return null;
});

const saving = ref(false);
const saveError = ref<string | null>(null);
const saved = ref<{ config: ConfigView; existed: boolean } | null>(null);

async function save() {
  const d = data.value;
  if (blocked.value || !d || !toolset.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    const known = new Set(d.configs.map((c) => c.hash));
    const config = await api.createConfig({
      name: form.name.trim(),
      harness: form.harness,
      model: form.model,
      prompt_sha256: form.prompt,
      toolset_sha256: toolset.value.sha256,
      settings: settings.value,
    });
    data.value = { ...d, configs: await api.configs() };
    saved.value = { config, existed: known.has(config.hash) };
  } catch (err) {
    saveError.value = errorWithFix(err);
  } finally {
    saving.value = false;
  }
}

// Any change after saving is a different agent: the saved panel goes until it is saved again.
// The source is a string, so reloading the configs after a save (same choices) is no change.
watch(
  () => JSON.stringify([form.harness, form.model, form.prompt, settings.value]),
  () => {
    saved.value = null;
    saveError.value = null;
  },
);

// ---------------------------------------------------------------- next steps

/** Two configs as paths and values, in the shape of GET /configs/:a/diff/:b, so the Run screen's
 *  own rule (axisFromDiff) says what they differ in. */
function diffOf(a: ConfigView, b: ConfigView): ConfigDiffEntry[] {
  const fields = (c: ConfigView) => ({ harness: c.harness, harness_ref: c.harness_ref, model: c.model, prompt: c.prompt.sha256, toolset: c.toolset.sha256, settings: c.settings, harness_options: c.harness_options, seed: c.seed });
  const out: ConfigDiffEntry[] = [];
  const walk = (path: string, x: unknown, y: unknown) => {
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    if (isObj(x) && isObj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(path ? `${path}.${k}` : k, x[k], y[k]);
    } else if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) {
      out.push({ path, a: (x ?? null) as ConfigDiffEntry['a'], b: (y ?? null) as ConfigDiffEntry['b'] });
    }
  };
  walk('', fields(a), fields(b));
  return out;
}

/** A saved agent that differs from this one in exactly one thing, the oldest first (the Run
 *  screen's baseline is the oldest): the obvious one to compare with. Null when there is none. */
const baseline = computed<{ config: ConfigView; axis: string } | null>(() => {
  const mine = saved.value?.config;
  if (!mine) return null;
  const others = [...(data.value?.configs ?? [])].filter((c) => c.hash !== mine.hash).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const c of others) {
    const axis = axisFromDiff(diffOf(c, mine), false);
    if (axis && axis !== 'none') return { config: c, axis };
  }
  return null;
});

/** Arm A is the baseline and arm B the agent: the comparison reads B minus A. With no obvious
 *  baseline, the Run screen starts arm A on the oldest saved agent and you pick there. */
const runLink = computed(() => {
  const mine = saved.value?.config;
  if (!mine) return href.runNew();
  return href.runNew(baseline.value?.config.hash, mine.hash);
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
      <fieldset class="step">
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
      <fieldset class="step">
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
          </label>
        </div>
        <p
          v-else
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
          <span>Running this agent calls a real model, so it costs money and needs <template v-if="keyName(model)">the provider's key, <span class="mono">{{ keyName(model) }}</span>,</template><template v-else>the provider's API key</template> in <span class="mono">.env</span>. Saving costs nothing; the Run screen shows the trials, models and cost before anything starts.</span>
        </p>
      </fieldset>

      <!-- 3. Instructions -->
      <fieldset class="step">
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
      <fieldset class="step">
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
            <input
              v-if="NUMBER_SETTINGS.includes(name)"
              :id="`build-${name}`"
              v-model="form.numbers[name]"
              type="text"
              inputmode="numeric"
              class="num num-input"
              :placeholder="usable(name) ? `${DEFAULT_WORDS[name]} (default)` : 'Not available'"
              :disabled="!usable(name)"
            >
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
      <fieldset class="step">
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
            data-test="agent-name"
            @input="nameTouched = true"
          >
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
              This agent was already saved as {{ saved.config.name }}, <span class="mono">{{ shortHash(saved.config.hash) }}</span>; nothing new was written.
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
            <li>
              <a
                :href="runLink"
                class="next-link"
                data-test="next-evaluate"
              >Evaluate it</a>
              <span
                class="secondary small block"
                data-test="next-evaluate-words"
              >
                <template v-if="baseline">Against {{ baseline.config.name }}, which differs from it only in {{ axisPhrase(baseline.axis) }}: that agent is arm A, the baseline, and this one arm B.</template>
                <template v-else>No saved agent differs from this one in just one thing, so the Run screen starts arm A, the baseline, on the oldest saved agent; pick the one you want there.</template>
                The Run screen shows the trials, models and cost before anything starts.
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
