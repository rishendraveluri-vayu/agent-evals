<script setup lang="ts">
/**
 * The full system prompt the model gets for a config (D33): the harness's own text with our task
 * prompt marked inside it. Rendering it runs one probe trial on the fake model through LiteLLM,
 * which costs nothing real, so the button needs no confirmation.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api/client';
import { ApiError, errorWithFix } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { RenderedPromptView } from '../api/types';
import { plural, relative, shortHash } from '../lib/format';
import { harnessShort } from '../lib/names';
import { href } from '../router';
import { bareToolName } from '../api/client';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ configHash: string; harness: string; promptName: string }>();
const emit = defineEmits<{ ready: [view: RenderedPromptView] }>();

const view = ref<RenderedPromptView | null>(null);
const loadError = ref<string | null>(null);
const busy = ref(false);
const postError = ref<string | null>(null);
const only = ref<'all' | 'harness'>('all');
let timer: ReturnType<typeof setTimeout> | null = null;

const live = (v: RenderedPromptView | null) => v?.status === 'queued' || v?.status === 'running';

async function load() {
  try {
    view.value = await api.renderedPrompt(props.configHash);
    loadError.value = null;
  } catch (err) {
    loadError.value = errorWithFix(err);
  }
  schedule();
}

/** While the probe is queued or running, ask again every 3 s (GET only reads). */
function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (live(view.value) && !isFixtureMode()) timer = setTimeout(() => void load(), 3000);
}

async function render() {
  busy.value = true;
  postError.value = null;
  try {
    view.value = await api.renderPrompt(props.configHash);
  } catch (err) {
    postError.value = err instanceof ApiError ? errorWithFix(err) : String(err);
  } finally {
    busy.value = false;
  }
  schedule();
}

watch(view, (v) => {
  if (v?.status === 'ready') emit('ready', v);
});
void load();
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

const who = computed(() => harnessShort(props.harness));

/** The system text in three parts: the harness's text before our prompt, ours, and after. */
const parts = computed(() => {
  const r = view.value?.rendered;
  if (!r) return null;
  if (!r.ours) return { before: r.system_text, ours: null, after: '' };
  return { before: r.system_text.slice(0, r.ours.start), ours: r.system_text.slice(r.ours.start, r.ours.end), after: r.system_text.slice(r.ours.end) };
});
const harnessAdds = computed(() => {
  const r = view.value?.rendered;
  if (!r) return null;
  const added = r.harness_text.replace('<<OUR TASK PROMPT>>', '').trim().length;
  return added;
});
const share = computed(() => {
  const r = view.value?.rendered;
  if (!r || !r.ours) return null;
  const ours = r.ours.end - r.ours.start;
  return Math.round((ours / Math.max(1, r.system_text.length)) * 100);
});
const statusWords = computed(() => {
  const v = view.value;
  if (!v) return '';
  switch (v.status) {
    case 'none':
      return 'Not rendered yet.';
    case 'queued':
      return `A probe trial is queued for the ${who.value} worker. This page checks again every few seconds.`;
    case 'running':
      return `The probe trial is running on ${who.value}. This page checks again every few seconds.`;
    case 'failed':
      return `The last probe gave no prompt: ${v.error ?? 'no reason given'}.`;
    default:
      return '';
  }
});
</script>

<template>
  <section
    aria-labelledby="rendered-title"
    class="panel panel--pad rendered"
    data-test="rendered-prompt"
  >
    <div class="panel-head">
      <h2
        id="rendered-title"
        class="section-title"
      >
        Rendered prompt
      </h2>
      <span
        v-if="view?.rendered"
        class="secondary smaller"
      >sha <span class="mono">{{ shortHash(view.rendered.sha256) }}</span>, rendered {{ relative(view.rendered.created_at).toLowerCase() }}</span>
    </div>
    <p class="secondary small intro">
      The whole system prompt the model sees: {{ who }}'s own text, with ours ({{ promptName }}) marked inside it. It comes from the first request of a probe trial that runs this config once on the fake model, so rendering it costs nothing.
    </p>

    <p
      v-if="loadError"
      class="error small"
      role="alert"
    >
      Could not load the rendered prompt: {{ loadError }}
    </p>
    <p
      v-else-if="!view"
      class="secondary small"
      role="status"
    >
      Loading the rendered prompt
    </p>
    <template v-else>
      <p
        v-if="statusWords"
        class="small"
        :role="view.status === 'failed' ? 'alert' : 'status'"
        data-test="rendered-status"
      >
        {{ statusWords }}
        <a
          v-if="view.probe"
          :href="href.trial(view.probe.trial_id)"
        >Open the probe trial</a>
      </p>
      <div
        v-if="view.status === 'none' || view.status === 'failed'"
        class="row"
      >
        <button
          type="button"
          class="btn"
          :disabled="busy"
          data-test="render-prompt"
          @click="render"
        >
          {{ view.status === 'failed' ? 'Try the probe again' : 'Render the prompt' }}
        </button>
        <span class="secondary smaller">One probe trial on <span class="mono">fake/finance-emi</span>: no real model, no real spend.</span>
      </div>
      <p
        v-if="postError"
        class="error small"
        role="alert"
      >
        {{ postError }}
      </p>

      <template v-if="view.rendered && parts">
        <p
          class="small"
          data-test="rendered-summary"
        >
          <template v-if="!harnessAdds">
            {{ who }} adds nothing: the model gets our prompt as it is.
          </template>
          <template v-else-if="parts.ours !== null">
            Our prompt is {{ share }}% of it; the rest is {{ who }}'s. {{ plural(view.rendered.tools.length, 'tool') }} sent with it.
          </template>
          <template v-else>
            Our prompt was not found in it word for word, so it cannot be marked, and the conflict check cannot run.
          </template>
        </p>
        <ul
          v-if="view.rendered.caveats.length"
          class="caveats small"
          data-test="rendered-caveats"
        >
          <li
            v-for="(c, i) in view.rendered.caveats"
            :key="i"
            class="caveat"
          >
            <AppIcon
              name="alert"
              :size="14"
            /><span>{{ c }}</span>
          </li>
        </ul>
        <div
          v-if="harnessAdds && parts.ours !== null"
          class="seg"
          role="group"
          aria-label="What to show"
        >
          <button
            type="button"
            :aria-pressed="only === 'all'"
            @click="only = 'all'"
          >
            Everything the model sees
          </button>
          <button
            type="button"
            :aria-pressed="only === 'harness'"
            data-test="harness-only"
            @click="only = 'harness'"
          >
            {{ who }}'s text only
          </button>
        </div>
        <pre
          class="code-block system-text"
          tabindex="0"
          :aria-label="`System prompt for this config, ${view.rendered.system_text.length} characters`"
          data-test="system-text"
        ><template v-if="only === 'harness'">{{ view.rendered.harness_text }}</template><template v-else>{{ parts.before }}<mark
          v-if="parts.ours !== null"
          class="ours"
          data-test="ours"
        ><span class="ours-label">Our prompt, {{ promptName }}, starts</span>{{ parts.ours }}<span class="ours-label">Our prompt ends</span></mark>{{ parts.after }}</template></pre>
        <p class="secondary smaller">
          <template v-if="view.rendered.normalised.length">
            Normalised so it compares across runs: {{ view.rendered.normalised.join('; ') }}.
          </template>
          Tools, in the order sent: <span class="mono">{{ view.rendered.tools.map(bareToolName).join(', ') }}</span>.
          <a :href="href.trial(view.rendered.trial_id)">Probe trial</a>
        </p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.panel-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 4px 12px;
}

.intro {
  margin: 4px 0 12px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 8px 0;
}

.caveats {
  list-style: none;
  margin: 8px 0;
  padding: 0;
}

.seg {
  margin: 8px 0;
}

.system-text {
  max-height: 520px;
  overflow: auto;
  font-size: 12.5px;
  line-height: 1.55;
  border: 1px solid var(--rule);
}

/* Ours is the shaded run of text with an ink rule; the labels at both ends say so in words. No
   hue: blue and orange mean arms A and B. */
.ours {
  background: var(--surface-muted);
  color: var(--ink);
  box-shadow: inset 3px 0 0 var(--ink);
  padding: 0 2px;
}

.ours-label {
  display: block;
  margin: 6px 0;
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  font-weight: 600;
  font-size: 12px;
  color: var(--ink);
}

.error {
  color: var(--error);
}
</style>
