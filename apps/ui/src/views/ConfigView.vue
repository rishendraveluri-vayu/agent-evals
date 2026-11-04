<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { api } from '../api/client';
import { errorText } from '../api/errors';
import { SETTING_NAMES, type Config, type ConfigDiffEntry, type Harness, type ModelInfo, type Prompt, type SettingName, type Settings, type Toolset } from '../api/types';
import LoadState from '../components/LoadState.vue';
import { useLoad } from '../lib/async';
import { changedLineCount, lineChanges, sentenceChanges } from '../lib/diff';
import { mdBlocks } from '../lib/markdown';
import { shortHash, shortRef } from '../lib/format';
import { BOOLEAN_SETTINGS, harnessName, harnessShort, modelName, settingLabel } from '../lib/names';
import { href, navigate } from '../router';
import { text } from '../trials';

interface Loaded {
  harnesses: Harness[];
  models: ModelInfo[];
  prompts: Prompt[];
  toolsets: Toolset[];
  configs: Config[];
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
const saveError = ref<string | null>(null);
const saved = ref<Config | null>(null);
const apiDiff = ref<ConfigDiffEntry[] | null>(null);
const showPrompt = ref(false);
const showPromptDiff = ref(false);

const versionNumber = (v: string) => Number(v.replace(/^v/, '')) || 0;

/** A new config starts as a copy of the oldest saved one (the baseline) with the newest version
 *  of its prompt, so trying a new prompt is one click and the diff says exactly what moved. */
watch(data, (d) => {
  if (!d || form.harness) return;
  const base = d.configs[d.configs.length - 1];
  baseHash.value = base?.hash ?? '';
  form.harness = base?.harness ?? d.harnesses[0]?.name ?? '';
  form.model = base?.model ?? d.models[0]?.name ?? '';
  const promptId = base?.prompt.id ?? d.prompts[0]?.id;
  const newest = d.prompts.filter((p) => p.id === promptId).sort((a, b) => versionNumber(b.version) - versionNumber(a.version))[0];
  form.prompt = newest?.sha256 ?? d.prompts[0]?.sha256 ?? '';
  form.toolset = base?.toolset.sha256 ?? d.toolsets[0]?.sha256 ?? '';
  for (const name of SETTING_NAMES) {
    const value = base?.settings[name];
    if (BOOLEAN_SETTINGS.includes(name)) form.toggles[name] = value === true;
    else form.numbers[name] = typeof value === 'number' ? String(value) : '';
  }
  for (const [k, v] of Object.entries(base?.harness_options ?? {})) form.options[k] = text(v);
});

const harness = computed(() => data.value?.harnesses.find((h) => h.name === form.harness) ?? null);
const model = computed(() => data.value?.models.find((m) => m.name === form.model) ?? null);
const prompt = computed(() => data.value?.prompts.find((p) => p.sha256 === form.prompt) ?? null);
const toolset = computed(() => data.value?.toolsets.find((t) => t.sha256 === form.toolset) ?? null);
const base = computed(() => data.value?.configs.find((c) => c.hash === baseHash.value) ?? null);
const tools = computed(() => toolset.value?.servers.flatMap((s) => s.allowed_tools) ?? []);

const supported = (name: SettingName) => harness.value?.capabilities.settings[name]?.supported ?? false;

/** The settings the form sets: numbers left empty are unset; toggles are always set. */
const settings = computed<Settings>(() => {
  const out: Settings = {};
  for (const name of SETTING_NAMES) {
    if (!supported(name)) continue;
    if (BOOLEAN_SETTINGS.includes(name)) out[name] = form.toggles[name] === true;
    else {
      const raw = form.numbers[name]?.trim();
      if (raw) out[name] = Number(raw);
    }
  }
  return out;
});

const optionProps = computed(() => Object.entries(harness.value?.capabilities.harness_options_schema.properties ?? {}));
const harnessOptions = computed(() => {
  const out: Record<string, unknown> = {};
  for (const [k, schema] of optionProps.value) {
    const raw = form.options[k];
    if (raw === undefined || raw === '') continue;
    out[k] = schema.type === 'boolean' ? raw === 'true' : schema.type === 'number' || schema.type === 'integer' ? Number(raw) : raw;
  }
  return out;
});

const suggestedName = computed(() => (prompt.value && harness.value ? `Prompt ${prompt.value.version} on ${harnessShort(harness.value.name)}` : ''));
watch(suggestedName, (n) => {
  if (!nameTouched.value) form.name = n;
});

const invalid = computed(() => {
  for (const name of SETTING_NAMES) {
    const raw = form.numbers[name]?.trim();
    if (supported(name) && raw && !Number.isFinite(Number(raw))) return `${settingLabel(name)} must be a number.`;
  }
  if (!form.name.trim()) return 'Give the config a name.';
  return null;
});

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
    const now = settings.value[name];
    if (was !== now) out.push(`${settingLabel(name)}: ${was === undefined ? 'unset' : text(was)} to ${now === undefined ? 'unset' : text(now)}`);
  }
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
  const same = (c: Config) =>
    c.harness === form.harness &&
    c.model === form.model &&
    c.prompt.sha256 === form.prompt &&
    c.toolset.sha256 === form.toolset &&
    JSON.stringify(Object.entries(c.settings).sort()) === JSON.stringify(Object.entries(settings.value).sort()) &&
    JSON.stringify(Object.entries(c.harness_options).sort()) === JSON.stringify(Object.entries(harnessOptions.value).sort());
  return d.configs.find(same) ?? null;
});
const shownHash = computed(() => saved.value?.hash ?? sameAs.value?.hash ?? null);

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

function ifUnset(name: SettingName): string {
  const cap = harness.value?.capabilities.settings[name];
  const who = harness.value ? harnessShort(harness.value.name) : 'harness';
  if (!cap?.supported) return `Not supported by ${harness.value ? harnessName(harness.value.name) : 'this harness'}`;
  if (BOOLEAN_SETTINGS.includes(name)) {
    if (cap.default === true) return `On (${who} default)`;
    if (cap.default === false) return 'Off';
    return 'Not sent';
  }
  if (name === 'temperature' && (cap.default === null || cap.default === undefined)) return 'Not sent; provider default';
  return 'Platform default';
}

function effect(name: SettingName): { text: string; kind: 'yes' | 'no' | 'todo' | 'na' } {
  const cap = harness.value?.capabilities.settings[name];
  if (!cap?.supported) return { text: '–', kind: 'na' };
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

function evidenceLine(h: Harness): string {
  const all = Object.values(h.capabilities.settings);
  const pending = all.filter((s) => s.evidence === 'none').length;
  const probed = all.filter((s) => s.evidence.startsWith('probe:')).length;
  if (pending) return `${pending} of ${all.length} settings not probed yet`;
  return `${probed} probed, ${all.length - probed} declared`;
}

async function save(thenRun: boolean) {
  if (invalid.value || !harness.value || !prompt.value || !toolset.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    const config = await api.createConfig({
      name: form.name.trim(),
      harness: form.harness,
      model: form.model,
      prompt_sha256: form.prompt,
      toolset_sha256: form.toolset,
      settings: settings.value,
      harness_options: harnessOptions.value,
    });
    saved.value = config;
    apiDiff.value = base.value && base.value.hash !== config.hash ? await api.configDiff(base.value.hash, config.hash) : [];
    if (thenRun) navigate(href.runNew(base.value && base.value.hash !== config.hash ? base.value.hash : undefined, config.hash));
  } catch (err) {
    saveError.value = errorText(err);
  } finally {
    saving.value = false;
  }
}

watch(
  () => [form.harness, form.model, form.prompt, form.toolset, JSON.stringify(settings.value), JSON.stringify(harnessOptions.value)],
  () => {
    saved.value = null;
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
      <a :href="href.experiments()">Experiments</a> / New config
    </nav>
    <h1 tabindex="-1">
      Define a config
    </h1>
    <p class="lede">
      A config is one harness, one model, one prompt, one toolset and its settings. Saving it gives it a content hash, so every result points back to exactly what produced it.
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
              <span class="smaller">{{ evidenceLine(h) }}</span>
            </label>
          </div>
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
              <option
                v-for="m in data.models"
                :key="m.name"
                :value="m.name"
              >{{ modelName(m.name) }}</option>
            </select>
            <span
              v-if="model"
              class="secondary smaller"
            >Price per million tokens: {{ perMillion(model.input_per_mtok) }} in, {{ perMillion(model.output_per_mtok) }} out, from the LiteLLM config</span>
          </label>
          <label class="field">
            <span class="legend">Prompt</span>
            <span class="hint-inline">Versioned files in configs/prompts. A used version is never edited.</span>
            <select
              v-model="form.prompt"
              data-test="prompt-select"
            >
              <option
                v-for="p in data.prompts"
                :key="p.sha256"
                :value="p.sha256"
              >{{ p.id }} {{ p.version }}</option>
            </select>
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
          <div class="table-scroll">
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
                <tr
                  v-for="name in SETTING_NAMES"
                  :key="name"
                  :data-test="`setting-${name}`"
                  :class="{ 'row--unsupported': !supported(name) }"
                >
                  <th scope="row">
                    <label
                      :for="`setting-${name}`"
                      class="strong"
                    >{{ settingLabel(name) }}</label>
                    <span
                      v-if="settingNote(name)"
                      class="secondary smaller block"
                    >{{ settingNote(name) }}</span>
                  </th>
                  <td>
                    <label
                      v-if="BOOLEAN_SETTINGS.includes(name)"
                      class="toggle"
                    >
                      <input
                        :id="`setting-${name}`"
                        v-model="form.toggles[name]"
                        type="checkbox"
                        :disabled="!supported(name)"
                      >
                      <span>{{ !supported(name) ? 'Not available' : form.toggles[name] ? 'On' : 'Off' }}</span>
                    </label>
                    <input
                      v-else
                      :id="`setting-${name}`"
                      v-model="form.numbers[name]"
                      type="text"
                      inputmode="decimal"
                      class="num-input num"
                      :disabled="!supported(name)"
                      :placeholder="supported(name) ? 'Unset' : 'Not available'"
                    >
                  </td>
                  <td class="secondary">
                    {{ ifUnset(name) }}
                  </td>
                  <td>
                    <span
                      v-if="supported(name) && harness?.capabilities.settings[name].native"
                      class="mono"
                    >{{ harness?.capabilities.settings[name].native }}</span>
                    <span
                      v-else
                      class="secondary"
                    >–</span>
                  </td>
                  <td>
                    <span
                      :class="{
                        'pill pill--pass pill--small': effect(name).kind === 'yes',
                        'pill pill--dashed pill--small': effect(name).kind === 'todo' || effect(name).kind === 'no',
                        secondary: effect(name).kind === 'na',
                      }"
                    >{{ effect(name).text }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
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
              data-test="config-name"
              @input="nameTouched = true"
            >
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
            <span class="secondary smaller block">{{ sameAs && !saved ? 'Same content as a saved config, so saving returns it. ' : '' }}Changes whenever anything on this page changes.</span>
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
                >Config {{ shortHash(c.hash) }}</option>
              </select>
              <span class="secondary smaller">{{ base?.name }}</span>
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
          <p
            v-if="saveError"
            class="error small"
            role="alert"
            data-test="save-error"
          >
            {{ saveError }}
          </p>
          <p
            v-else-if="invalid"
            class="secondary small"
          >
            {{ invalid }}
          </p>
          <p
            v-else-if="saved"
            class="small saved"
            role="status"
          >
            Saved as config <span class="mono">{{ shortHash(saved.hash) }}</span>.
          </p>
          <div class="divided buttons">
            <button
              type="button"
              class="btn"
              :disabled="saving || !!invalid"
              data-test="save-config"
              @click="save(false)"
            >
              Save config
            </button>
            <button
              type="button"
              class="btn btn--quiet"
              :disabled="saving || !!invalid"
              data-test="save-and-run"
              @click="save(true)"
            >
              Save and set up a run
            </button>
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
      </aside>
    </div>
  </LoadState>
</template>

<style scoped>
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
  color: var(--pass);
}

.toolset-pick {
  margin-bottom: 12px;
}

.table-scroll {
  overflow-x: auto;
}

.settings {
  min-width: 760px;
}

.settings tr > :first-child {
  padding-left: 0;
}

.settings tr > :last-child {
  padding-right: 0;
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

.options summary {
  cursor: pointer;
  min-height: 44px;
  display: flex;
  align-items: center;
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
  color: var(--fail);
}

.saved {
  color: var(--pass);
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
