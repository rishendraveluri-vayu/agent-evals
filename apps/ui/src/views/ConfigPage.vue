<script setup lang="ts">
/**
 * One saved config: what it is, every setting with where its value comes from (R11b: harness
 * defaults shown), what the harness or model ignores and why, its lineage (D34), and the pre-run
 * checks: the rendered prompt and the conflict check (D33, D38).
 */
import { computed, ref, shallowRef } from 'vue';
import { api } from '../api/client';
import { ApiError, errorWithFix } from '../api/errors';
import { SETTING_NAMES, type ConfigDiffEntry, type ConfigView, type Harness, type ModelView, type RenderedPromptStatus, type SettingName, type SpendView } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import ConflictCheck from '../components/ConflictCheck.vue';
import LoadState from '../components/LoadState.vue';
import RenderedPrompt from '../components/RenderedPrompt.vue';
import { optional, useLoad } from '../lib/async';
import { plainText, relative, shortHash, shortRef } from '../lib/format';
import { harnessName, harnessShort, modelName, settingLabel } from '../lib/names';
import { changeWords, configChanges, contentDiff } from '../lib/checks';
import { missingKey, needsKeyWords } from '../lib/runSetup';
import { settingValue, sourceWords } from '../lib/settings';
import { href } from '../router';
import { text } from '../trials';

const props = defineProps<{ configHash: string }>();

/** The address holds no saved config: a mistyped or malformed id, or one never saved. */
const missing = ref(false);
async function configOrMissing(hash: string) {
  try {
    return await api.config(hash);
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'invalid_hash' || err.code === 'unknown_config' || err.status === 404)) missing.value = true;
    throw err;
  }
}

const { data, error, loading } = useLoad(async () => {
  const [config, configs, harnesses, spend, models] = await Promise.all([
    configOrMissing(props.configHash),
    optional(api.configs(), [] as ConfigView[]),
    optional(api.harnesses(), [] as Harness[]),
    optional(api.spend(), null as SpendView | null),
    // Only to say which keys are missing (key_set); the page works without it.
    optional(api.models(), [] as ModelView[]),
  ]);
  return { config, configs, harness: harnesses.find((h) => h.name === config.harness) ?? null, spend, models };
});

/** The model the conflict check calls (D38). */
const CHECKER_MODEL = 'claude-sonnet-5-5';
/** "needs ANTHROPIC_API_KEY in .env" for this config's model, when its key is not set. */
const modelNeedsKey = computed(() => (data.value ? needsKeyWords(data.value.config.model, data.value.models) : ''));
const checkerKey = computed(() => (data.value ? missingKey(CHECKER_MODEL, data.value.models) : null));

const parent = computed(() => {
  const c = data.value?.config;
  if (!c?.parent_hash) return null;
  return data.value?.configs.find((x) => x.hash === c.parent_hash) ?? { hash: c.parent_hash, name: `config ${shortHash(c.parent_hash)}` };
});

const rows = computed(() => {
  const d = data.value;
  if (!d) return [];
  const c = d.config;
  return SETTING_NAMES.map((name: SettingName) => {
    const cap = d.harness?.capabilities.settings[name];
    const source = c.settings_sources[name];
    const reason = c.unsupported?.[name] ?? null;
    return {
      name,
      label: settingLabel(name),
      value: settingValue(name, c.settings[name]),
      source: sourceWords(source, harnessShort(c.harness), cap),
      reason,
      ignored: source === 'unsupported' || !!reason,
      // The adapter's own words, without its references to the decision log ("(D36)").
      native: cap?.supported && cap.native ? plainText(cap.native) : null,
    };
  });
});

const showDiff = ref(false);
const diff = shallowRef<ConfigDiffEntry[] | null>(null);
/** What this config changes from its parent, in words with both values ("Max steps 12 vs 10"),
 *  once both are known; the API's field paths stay in a Details disclosure. */
const parentChanges = computed(() => {
  const p = parent.value;
  const c = data.value?.config;
  return p && c && 'harness' in p && diff.value ? configChanges(p, c).map(changeWords) : null;
});
/** The API's diff without bookkeeping (where a setting's value came from), for Details. */
const parentFields = computed(() => contentDiff(diff.value ?? []));
const diffError = ref<string | null>(null);
async function toggleDiff() {
  showDiff.value = !showDiff.value;
  if (!showDiff.value || diff.value || !parent.value) return;
  try {
    diff.value = await api.configDiff(parent.value.hash, props.configHash);
    diffError.value = null;
  } catch (err) {
    diffError.value = errorWithFix(err);
  }
}

/** Where the rendered prompt stands, as its panel read it: the conflict check waits for it. */
const renderedStatus = ref<RenderedPromptStatus | 'unknown' | null>(null);
const allowance = computed(() => data.value?.spend?.allowances.find((a) => a.kind === 'conflict_check') ?? null);
/** After a paid check, the header's spend and this allowance are out of date: read them again. */
async function refreshSpend() {
  const d = data.value;
  if (!d) return;
  const spend = await optional(api.spend(), d.spend);
  data.value = { ...d, spend };
  window.dispatchEvent(new CustomEvent('evals:spend-changed'));
}
</script>

<template>
  <div
    v-if="missing"
    class="page-head"
    data-test="config-missing"
  >
    <nav
      aria-label="Breadcrumb"
      class="crumbs"
    >
      <a :href="href.config()">Configs</a> / Not found
    </nav>
    <h1 tabindex="-1">
      No agent with that id
    </h1>
    <p class="lede">
      Nothing is saved as <span class="mono">{{ configHash }}</span>. <a :href="href.config()">Configs</a> lists every saved agent, and <a :href="href.build()">Build an agent</a> makes a new one.
    </p>
  </div>
  <LoadState
    v-else
    :loading="loading"
    :error="error"
    what="this config"
  >
    <template v-if="data">
      <div class="head-row">
        <div class="page-head">
          <nav
            aria-label="Breadcrumb"
            class="crumbs"
          >
            <a :href="href.config()">Configs</a> / {{ data.config.name }}
          </nav>
          <h1
            tabindex="-1"
            data-test="config-title"
          >
            {{ data.config.name }}
          </h1>
          <p
            class="secondary small meta"
            data-test="config-meta"
          >
            Config <span class="mono">{{ shortHash(data.config.hash) }}</span> · {{ harnessName(data.config.harness) }} <span class="mono">{{ shortRef(data.config.harness_ref) }}</span> · {{ modelName(data.config.model) }} ·
            prompt {{ data.config.prompt.id }} {{ data.config.prompt.version }} · toolset {{ data.config.toolset.id }} {{ data.config.toolset.version }} · saved {{ relative(data.config.created_at).toLowerCase() }}
          </p>
          <p
            v-if="modelNeedsKey"
            class="small needs-key"
            data-test="config-needs-key"
          >
            {{ modelName(data.config.model) }} {{ modelNeedsKey }} to run: it is not set. Add it, then run <span class="mono">docker compose up -d</span>.
          </p>
          <p
            v-if="data.config.example_only"
            class="small example-note"
            data-test="config-example-only"
          >
            This config came with the shipped example, made elsewhere with the files of its day, and is kept as it was run. To run it again, fork it: the fork starts with today's prompt and tools where these are gone.
          </p>
        </div>
        <div class="actions">
          <a
            :href="href.fork(data.config.hash)"
            class="btn"
            data-test="fork"
          >Fork this config</a>
          <a
            v-if="!data.config.example_only"
            :href="href.runNew(parent?.hash, data.config.hash)"
            class="btn btn--quiet"
            data-test="set-up-run"
          >Set up a run</a>
        </div>
      </div>

      <section
        v-if="data.config.warnings?.length"
        class="warnings"
        aria-label="Warnings"
        data-test="config-warnings"
      >
        <div
          v-for="w in data.config.warnings"
          :key="w.code"
          class="warning"
          role="note"
        >
          <AppIcon
            name="alert"
            :size="18"
          />
          <div>
            <p class="small strong">
              {{ w.message }}
            </p>
            <p class="small">
              <strong>How to avoid it:</strong> {{ w.fix }}
            </p>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="lineage"
        class="panel panel--pad lineage"
        data-test="lineage"
      >
        <h2
          id="lineage"
          class="section-title"
        >
          Lineage
        </h2>
        <p
          v-if="parent"
          class="small"
        >
          Forked from <a :href="href.configPage(parent.hash)">{{ parent.name }}</a> (<span class="mono">{{ shortHash(parent.hash) }}</span>).
          <button
            type="button"
            class="link-button"
            :aria-expanded="showDiff"
            data-test="compare-parent"
            @click="toggleDiff"
          >
            {{ showDiff ? 'Hide the comparison' : 'Compare with parent' }}
          </button>
        </p>
        <p
          v-else
          class="small secondary"
        >
          Not forked from another config.
        </p>
        <template v-if="showDiff">
          <p
            v-if="diffError"
            class="error small"
            role="alert"
          >
            {{ diffError }}
          </p>
          <template v-else-if="diff && (parentChanges ?? parentFields).length">
            <ul
              class="diff small"
              data-test="parent-diff"
            >
              <template v-if="parentChanges">
                <li
                  v-for="c in parentChanges"
                  :key="c"
                >
                  {{ c }}
                </li>
              </template>
              <li v-else>
                {{ parentFields.length }} {{ parentFields.length === 1 ? 'field differs' : 'fields differ' }}: see Details.
              </li>
            </ul>
            <p class="small secondary">
              The parent's value comes first. Everything else is identical.
            </p>
            <details
              class="smaller parent-fields"
              data-test="parent-fields"
            >
              <summary>Details: each field and its values</summary>
              <ul class="mono">
                <li
                  v-for="d in parentFields"
                  :key="d.path"
                >
                  {{ d.path }}: {{ text(d.a) }} to {{ text(d.b) }}
                </li>
              </ul>
            </details>
          </template>
          <p
            v-else-if="diff"
            class="small secondary"
          >
            Identical to its parent in everything that changes behaviour.
          </p>
          <p
            v-else
            class="small secondary"
            role="status"
          >
            Loading the comparison
          </p>
        </template>
        <p
          v-if="data.config.children?.length"
          class="small"
          data-test="children"
        >
          Forked into:
          <template
            v-for="(child, ci) in data.config.children"
            :key="child.hash"
          >
            <a :href="href.configPage(child.hash)">{{ child.name }}</a>{{ ci < data.config.children.length - 1 ? ', ' : '' }}
          </template>
        </p>
      </section>

      <section
        aria-labelledby="settings-title"
        class="panel settings-panel"
      >
        <h2
          id="settings-title"
          class="section-title settings-title"
        >
          Settings
        </h2>
        <p class="secondary small settings-intro">
          Every setting, with where its value comes from. A setting {{ harnessShort(data.config.harness) }} or {{ modelName(data.config.model) }} ignores is greyed out, with the reason.
        </p>
        <div class="settings-box">
          <table
            class="table settings"
            data-test="config-settings"
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
                  Where it comes from
                </th>
                <th scope="col">
                  Reaches the model as
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in rows"
                :key="r.name"
                :class="{ 'row--ignored': r.ignored }"
                :data-test="`config-setting-${r.name}`"
              >
                <th scope="row">
                  {{ r.label }}
                </th>
                <td
                  class="num"
                  data-label="Value"
                >
                  {{ r.value }}
                </td>
                <td data-label="Where it comes from">
                  {{ r.source }}
                  <span
                    v-if="r.reason"
                    class="block reason"
                    data-test="ignored-reason"
                  >{{ r.reason }}</span>
                </td>
                <td data-label="Reaches the model as">
                  <span
                    v-if="r.native && !r.ignored"
                    class="mono"
                  >{{ r.native }}</span>
                  <span
                    v-else
                    class="secondary"
                  >–</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section
        aria-labelledby="seed-title"
        class="panel panel--pad seed-panel"
        data-test="config-seed"
      >
        <h2
          id="seed-title"
          class="section-title"
        >
          Seeds
        </h2>
        <p
          v-if="!data.config.seed?.memory?.length && !data.config.seed?.skills?.length"
          class="small secondary"
        >
          Nothing seeded: every trial starts with empty memory and no skills of its own.
        </p>
        <template v-else>
          <p class="small secondary">
            Every trial starts with these, given by the config, never learned.
          </p>
          <ol
            v-if="data.config.seed.memory.length"
            class="small seed-list"
            aria-label="Memory entries"
          >
            <li
              v-for="(m, mi) in data.config.seed.memory"
              :key="mi"
            >
              {{ m }}
            </li>
          </ol>
          <details
            v-for="k in data.config.seed.skills"
            :key="k.name"
            class="disclosure"
          >
            <summary>
              <span class="summary-text"><span class="mono strong">{{ k.name }}</span> <span class="secondary small">{{ k.description }}</span></span>
            </summary>
            <pre class="code-block">{{ k.body }}</pre>
          </details>
        </template>
      </section>

      <div class="checks">
        <RenderedPrompt
          :config-hash="data.config.hash"
          :harness="data.config.harness"
          :prompt-name="`${data.config.prompt.id} ${data.config.prompt.version}`"
          @status="renderedStatus = $event"
        />
        <ConflictCheck
          :config-hash="data.config.hash"
          :harness="data.config.harness"
          :rendered-status="renderedStatus"
          :allowance="allowance"
          :key-missing="checkerKey"
          @spent="refreshSpend"
        />
      </div>
    </template>
  </LoadState>
</template>

<style scoped>
.seed-list {
  margin: 6px 0;
  padding-left: 20px;
}

.meta {
  margin-top: 6px;
}

.needs-key,
.example-note {
  margin: 8px 0 0;
  max-width: 72ch;
}

.needs-key {
  font-weight: 600;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
}

.warnings {
  display: grid;
  gap: 8px;
  margin-bottom: 20px;
}

/* A warning: an alert icon and words in ink, with a heavier rule; never a pass or fail hue. */
.warning {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  background: var(--surface);
  border: 1px solid var(--rule-strong);
  border-left: 4px solid var(--warning);
  border-radius: 10px;
}

.warning p {
  margin: 0 0 4px;
}

.strong {
  font-weight: 600;
}

.lineage,
.settings-panel,
.seed-panel {
  margin-bottom: 20px;
}

.lineage p {
  margin: 4px 0;
}

.diff {
  margin: 6px 0;
  padding-left: 18px;
}

.parent-fields ul {
  margin: 6px 0 0;
  padding-left: 18px;
  overflow-wrap: anywhere;
}

.link-button {
  padding: 0 4px;
  min-height: 32px;
  background: none;
  border: 0;
  color: var(--ink);
  text-decoration: underline;
  text-decoration-color: var(--rule-strong);
  text-underline-offset: 3px;
  cursor: pointer;
  font: inherit;
}

.settings-title,
.settings-intro {
  padding: 0 20px;
}

.settings-title {
  padding-top: 18px;
}

.settings-box {
  container-type: inline-size;
}

/* Every column fits: the natives (long call paths) wrap anywhere, the rest between words. */
.settings .mono {
  white-space: normal;
  overflow-wrap: anywhere;
}

/* Narrow: each setting is a block, its columns labelled lines. */
@container (max-width: 559px) {
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
    padding: 12px 20px;
    border-bottom: 1px solid var(--rule-soft);
  }

  .settings tbody tr:last-child {
    border-bottom: 0;
  }

  .settings tbody tr > *,
  .settings tbody tr > :first-child,
  .settings tbody tr > :last-child {
    padding: 3px 0;
    border-bottom: 0;
  }

  .settings tbody th {
    font-weight: 600;
  }

  /* Each column a labelled line: its label on the left, its value on the right. */
  .settings td[data-label] {
    display: grid;
    grid-template-columns: 10.5em minmax(0, 1fr);
    gap: 10px;
  }

  .settings td[data-label]::before {
    content: attr(data-label);
    font-size: 13px;
    color: var(--ink-2);
    padding-top: 1px;
  }
}

.row--ignored th,
.row--ignored td {
  color: var(--ink-2);
}

.row--ignored th {
  text-decoration: line-through;
  text-decoration-color: var(--rule-strong);
}

.reason {
  margin-top: 2px;
  font-size: 13px;
  color: var(--ink-2);
}

.checks {
  display: grid;
  gap: 20px;
}

@media (min-width: 1100px) {
  .checks {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    align-items: start;
  }
}

.error {
  color: var(--error);
}
</style>
