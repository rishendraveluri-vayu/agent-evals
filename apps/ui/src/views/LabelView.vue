<script setup lang="ts">
/**
 * Blind labelling. This screen renders only the fields of a blind item: the task, the
 * conversation, the tool calls and the questions. It never shows a harness, model, arm,
 * timing, cost or grade, and the client strips any such field before it gets here
 * (toBlindItem). Labels are Rishi's own judgments; nothing here fills one in for him.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { api } from '../api/client';
import { errorText } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { BlindItem, Criterion, LabelSet, LabelValue } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import LoadState from '../components/LoadState.vue';
import { optional, useLoad } from '../lib/async';
import { href } from '../router';

const fixtures = isFixtureMode();
const SETS: { set: LabelSet; name: string; file: string }[] = [
  { set: 'tuning', name: 'Tuning', file: 'labels/tuning.jsonl' },
  { set: 'heldout', name: 'Held-out', file: 'labels/heldout.jsonl' },
  { set: 'final', name: 'Final run', file: 'labels/final.jsonl' },
];
const VALUES: { value: LabelValue; text: string; key: string }[] = [
  { value: 'yes', text: 'Yes', key: '1' },
  { value: 'no', text: 'No', key: '2' },
  { value: 'unsure', text: 'Not sure', key: '3' },
];

const set = ref<LabelSet>('heldout');
const { data, error, loading } = useLoad(async () => {
  const entries = await Promise.all(SETS.map(async (s) => [s.set, await optional(api.labelQueue(s.set), null)] as const));
  return Object.fromEntries(entries) as Record<LabelSet, BlindItem[] | null>;
});

const queue = computed(() => data.value?.[set.value] ?? null);
const index = ref(0);
const item = computed(() => queue.value?.[index.value] ?? null);
const answers = reactive<Record<string, LabelValue | undefined>>({});
const note = ref('');
const active = ref(0);
const saving = ref(false);
const saveError = ref<string | null>(null);
const savedCount = ref(0);

const criteria = computed(() => (item.value?.criteria ?? []).map((c: Criterion) => (typeof c === 'string' ? { id: c, question: c } : c)));
const allAnswered = computed(() => criteria.value.length > 0 && criteria.value.every((c) => answers[c.id]));
const left = computed(() => (queue.value ? Math.max(0, queue.value.length - index.value) : 0));
const setFile = computed(() => SETS.find((s) => s.set === set.value)?.file ?? '');

function reset() {
  for (const k of Object.keys(answers)) delete answers[k];
  note.value = '';
  active.value = 0;
  saveError.value = null;
}
watch(set, () => {
  index.value = 0;
  reset();
});

function choose(criterionIndex: number, value: LabelValue) {
  const c = criteria.value[criterionIndex];
  if (!c) return;
  answers[c.id] = answers[c.id] === value ? undefined : value;
  active.value = criterionIndex;
}

async function saveAndNext() {
  const current = item.value;
  if (!current || !allAnswered.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    for (const c of criteria.value) {
      await api.saveLabel({ item_id: current.item_id, set: set.value, criterion: c.id, value: answers[c.id] as LabelValue, note: note.value.trim() });
    }
    savedCount.value += 1;
    index.value += 1;
    reset();
  } catch (err) {
    saveError.value = errorText(err);
  } finally {
    saving.value = false;
  }
}

function skip() {
  index.value += 1;
  reset();
}

/** 1, 2 and 3 answer the selected question, unless the focus is in the note. */
function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const v = VALUES.find((x) => x.key === e.key);
  if (!v || !item.value) return;
  e.preventDefault();
  choose(active.value, v.value);
  if (active.value < criteria.value.length - 1) active.value += 1;
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const setLabel = (s: LabelSet, name: string) => {
  const q = data.value?.[s];
  return q ? `${name}, ${q.length} to go` : name;
};
const pretty = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const paragraphs = (text: string) => text.split(/\n{2,}/);
</script>

<template>
  <div class="head-row">
    <div class="page-head">
      <h1 tabindex="-1">
        Label outputs
      </h1>
      <p class="lede">
        Your judgments are the ground truth the judge is measured against.
        <!-- While this set has items to go, the judge's verdicts stay out of sight, so labelling stays blind. -->
        <span
          v-if="queue && left > 0"
          data-test="judge-later"
        >The judge's reasons open on the Judge page when this set is done ({{ left }} to go).</span>
        <a
          v-else-if="!loading"
          :href="href.judge()"
          data-test="judge-link"
        >See judge agreement</a>
      </p>
    </div>
    <div
      role="group"
      aria-label="Label set"
      class="seg"
    >
      <button
        v-for="s in SETS"
        :key="s.set"
        type="button"
        :aria-pressed="set === s.set"
        :data-test="`set-${s.set}`"
        @click="set = s.set"
      >
        {{ setLabel(s.set, s.name) }}
      </button>
    </div>
  </div>

  <div
    class="panel blind-note small"
    data-test="blind-note"
  >
    <AppIcon
      name="eye-off"
      class="secondary"
    />
    <span>Hidden from you: the harness, the model, the arm, the timing, the cost and the judge's verdict. Outputs come in a random order, mixed across configs. Trial pages still show the arm and the judge's pass or fail, so label a task before opening its trials.</span>
    <span
      v-if="queue"
      class="progress num"
    >{{ left }} to go<template v-if="savedCount">, {{ savedCount }} saved this session</template></span>
  </div>

  <LoadState
    :loading="loading"
    :error="error"
    what="the labelling queue"
  >
    <p
      v-if="queue === null"
      class="panel empty"
      role="status"
    >
      The {{ SETS.find((s) => s.set === set)?.name.toLowerCase() }} queue could not be loaded.
    </p>
    <p
      v-else-if="!item"
      class="panel empty"
      role="status"
      data-test="queue-empty"
    >
      Nothing left to label in this set.
    </p>
    <div
      v-else
      class="split"
      data-test="blind-item"
    >
      <section
        aria-labelledby="output"
        class="grow stack"
      >
        <h2
          id="output"
          class="section-title"
          :class="{ mono: item.task_id }"
        >
          {{ item.task_id ?? 'The output to label' }}
        </h2>
        <p
          v-if="item.task_summary"
          class="secondary small summary"
        >
          {{ item.task_summary }}
        </p>
        <template
          v-for="(m, i) in item.transcript"
          :key="i"
        >
          <details
            v-if="m.role === 'assistant' && i === item.transcript.findIndex((x) => x.role === 'assistant') && item.tool_calls.length"
            class="disclosure"
          >
            <summary>
              <span class="summary-text">
                <span class="strong">{{ item.tool_calls.length }} tool {{ item.tool_calls.length === 1 ? 'call' : 'calls' }}</span>
                <span class="secondary small mono">{{ item.tool_calls.map((t) => t.name).join(', ') }}</span>
              </span>
            </summary>
            <p class="secondary small gap-below">
              Arguments and results, without timings or costs, which could hint at the config.
            </p>
            <div
              v-for="(t, ti) in item.tool_calls"
              :key="ti"
              class="tool"
            >
              <span class="mono strong">{{ t.name }}</span>
              <div class="tool-body">
                <pre class="code-block">{{ pretty(t.arguments) }}</pre>
                <pre class="code-block">{{ pretty(t.result) }}</pre>
              </div>
            </div>
          </details>
          <article
            class="bubble"
            :class="m.role === 'assistant' ? 'bubble--agent' : 'bubble--client'"
          >
            <span class="bubble-who">{{ m.role === 'assistant' ? 'Agent' : 'Client' }}</span>
            <p
              v-for="(p, pi) in paragraphs(m.content)"
              :key="pi"
              class="bubble-text"
            >
              {{ p }}
            </p>
          </article>
        </template>
      </section>

      <aside
        aria-labelledby="rubric"
        class="side panel panel--pad judgment"
      >
        <div>
          <h2
            id="rubric"
            class="section-title"
          >
            Your judgment
          </h2>
          <p class="secondary small hint">
            Press 1, 2 or 3 to answer the selected question.
          </p>
        </div>
        <div class="criteria">
          <fieldset
            v-for="(c, ci) in criteria"
            :key="c.id"
            class="criterion"
            :class="{ 'criterion--active': ci === active }"
            data-test="criterion"
          >
            <legend class="strong">
              {{ c.question }}
            </legend>
            <div class="answers">
              <button
                v-for="v in VALUES"
                :key="v.value"
                type="button"
                class="answer"
                :class="`answer--${v.value}`"
                :aria-pressed="answers[c.id] === v.value"
                @click="choose(ci, v.value)"
                @focus="active = ci"
              >
                {{ v.text }}
              </button>
            </div>
          </fieldset>
        </div>
        <label class="field small">
          <span class="strong">Note, optional</span>
          <textarea
            v-model="note"
            rows="3"
            placeholder="What made you decide, in a sentence"
          />
        </label>
        <p
          v-if="saveError"
          class="error small"
          role="alert"
        >
          {{ saveError }}
        </p>
        <div class="buttons">
          <button
            type="button"
            class="btn grow-btn"
            :disabled="!allAnswered || saving"
            data-test="save-label"
            @click="saveAndNext"
          >
            Save and next
          </button>
          <button
            type="button"
            class="btn btn--quiet"
            @click="skip"
          >
            Skip
          </button>
        </div>
        <p
          v-if="!allAnswered"
          class="secondary smaller"
        >
          Answer every question to save; "Not sure" counts as an answer.
        </p>
        <p
          class="secondary smaller"
          data-test="label-file"
        >
          <template v-if="fixtures">
            Sample data: nothing is saved in this mode.
          </template>
          <template v-else>
            Saved to {{ setFile }} with today's date. Synthetic examples live in their own file and never appear here.
          </template>
        </p>
      </aside>
    </div>
  </LoadState>
</template>

<style scoped>
.blind-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 10px;
}

.blind-note > span:first-of-type {
  flex: 1 1 300px;
}

.progress {
  margin-left: auto;
  white-space: nowrap;
}

.summary {
  max-width: 72ch;
}

.strong {
  font-weight: 500;
}

.gap-below {
  margin-bottom: 12px;
}

.tool {
  padding-bottom: 14px;
}

.tool-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
  margin-top: 6px;
}

.judgment {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.criteria {
  display: flex;
  flex-direction: column;
}

.hint {
  margin-top: 4px;
}

/* Every question keeps the same box, so moving the selection does not shift the layout; the one
   that 1, 2 and 3 answer sits in a grey band. The legend floats so it sits inside the padding. */
.criterion {
  margin: 0 -12px;
  padding: 10px 12px;
  border: 0;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.criterion legend {
  float: left;
  width: 100%;
  padding: 0;
}

.criterion--active {
  background: var(--surface-muted);
}

.answers {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.answer {
  min-height: 44px;
  border: 1px solid var(--rule);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
}

.answer--yes[aria-pressed='true'] {
  border: 2px solid var(--pass);
  background: var(--pass-soft);
  color: var(--pass);
  font-weight: 600;
}

.answer--no[aria-pressed='true'] {
  border: 2px solid var(--fail);
  background: var(--fail-soft);
  color: var(--fail);
  font-weight: 600;
}

.answer--unsure[aria-pressed='true'] {
  border: 2px solid var(--ink);
  background: var(--surface-muted);
  color: var(--ink);
  font-weight: 600;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.buttons {
  display: flex;
  gap: 8px;
}

.grow-btn {
  flex: 1;
}

.error {
  color: var(--error);
}
</style>
