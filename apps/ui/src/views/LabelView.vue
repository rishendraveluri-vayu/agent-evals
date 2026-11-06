<script setup lang="ts">
/**
 * Blind labelling. This screen renders only the fields of a blind item: the task, the
 * conversation, the tool calls and the questions. It never shows a harness, model, arm,
 * timing, cost or grade, and the client strips any such field before it gets here
 * (toBlindItem). Labels are human judgments, Rishi's and the raters he names (D73); nothing here
 * fills one in. Each person labels under their own rater id, with their own queue and second
 * looks, and the screen never shows another rater's labels or says that another rater exists.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { api } from '../api/client';
import { errorText } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { BlindItem, LabelSet, LabelValue } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import LoadState from '../components/LoadState.vue';
import { optional, useLoad } from '../lib/async';
import { mdBlocks } from '../lib/markdown';
import { raterFrom, rememberRater, storedRater } from '../lib/rater';
import { href } from '../router';

/** `set`, `experiment` and `items` come from the address (#/labels?set=heldout&items=t_a,t_b): the
 *  set to open on, one batch to label, or a chosen list of trials (GET /labels/queue takes both),
 *  such as the trials a judge panel disagreed on (D71). `calibrate` (with an experiment, D83) asks
 *  for that batch in an order that balances its judge's passes and fails; the items still carry no
 *  verdict. */
const props = defineProps<{ initialSet?: LabelSet | null; experiment?: string | null; items?: string | null; calibrate?: boolean }>();
/** Calibrating needs an experiment: the API refuses it on the whole queue. */
const calibrating = !!props.calibrate && !!props.experiment;

const fixtures = isFixtureMode();
const SETS: { set: LabelSet; name: string; file: string; purpose: string }[] = [
  {
    set: 'tuning',
    name: 'Tuning',
    file: 'labels/tuning.jsonl',
    purpose: 'Open coding before any rubric: your pass or fail and a line on why. Trials of discovery tasks only. These shape the rubric and never count towards the judge’s reported agreement.',
  },
  { set: 'heldout', name: 'Held-out', file: 'labels/heldout.jsonl', purpose: 'Your judgments are the ground truth the judge is measured against. Trials of held-out tasks only, so the judge is never scored on a task its rubric was tuned on.' },
  { set: 'final', name: 'Final run', file: 'labels/final.jsonl', purpose: 'Labels from the real experiment, to check the judge on the final model’s outputs. Trials of held-out tasks only.' },
];
const VALUES: { value: LabelValue; text: string; key: string }[] = [
  { value: 'yes', text: 'Yes', key: '1' },
  { value: 'no', text: 'No', key: '2' },
  { value: 'unsure', text: 'Not sure', key: '3' },
];

/** Who is labelling, remembered in this browser. Nothing loads or saves until it is given: the
 *  queue and its second looks are this person's own. */
const rater = ref<string | null>(storedRater());
const editingRater = ref(rater.value === null);
const raterDraft = ref(rater.value ?? '');
const raterError = ref<string | null>(null);
const raterInput = ref<HTMLInputElement | null>(null);

const set = ref<LabelSet>(props.initialSet ?? 'tuning');
const { data, error, loading, reload } = useLoad(async () => {
  const who = rater.value;
  if (!who) return null;
  const entries = await Promise.all(
    SETS.map(async (s) => [s.set, await optional(api.labelQueue(s.set, props.experiment ?? undefined, props.items ?? undefined, who, calibrating), null)] as const),
  );
  return Object.fromEntries(entries) as Record<LabelSet, BlindItem[] | null>;
});
/** Opens on the first set with something to label, unless the address names one. */
watch(data, (d, before) => {
  if (!d || before || props.initialSet) return;
  const first = SETS.find((s) => (d[s.set]?.length ?? 0) > 0);
  if (first) set.value = first.set;
});

/** Items saved this visit, by set: they leave their queue at once, so every "to go" count is right
 *  without loading the queue again. */
const savedIds = reactive<Record<LabelSet, string[]>>({ tuning: [], heldout: [], final: [] });
/** What is still to label in a set: as loaded, less what was saved since. Skipped items stay.
 *  Nothing while the id is being changed: the queue loaded is the last id's. */
const remainingOf = (s: LabelSet) => {
  if (editingRater.value) return null;
  const q = data.value?.[s];
  return q ? q.filter((i) => !savedIds[s].includes(i.item_id)) : null;
};
const queue = computed(() => remainingOf(set.value));
/** The current item's place among those still to label: a save leaves it where it is (the next
 *  item moves up), a skip moves past it. */
const index = ref(0);
const item = computed(() => queue.value?.[index.value] ?? null);
const answers = reactive<Record<string, LabelValue | undefined>>({});
const note = ref('');
const active = ref(0);
const saving = ref(false);
const saveError = ref<string | null>(null);
const savedCount = computed(() => savedIds[set.value].length);
const skippedCount = ref(0);
/** "Not sure" answers saved this visit on fresh items: each comes back once for a second look. */
const unsureSaved = ref(0);
const secondLookNote = computed(() =>
  unsureSaved.value
    ? `You marked ${unsureSaved.value === 1 ? 'one question' : `${unsureSaved.value} questions`} "Not sure": ${unsureSaved.value === 1 ? 'it comes' : 'they come'} back once for a second look. `
    : '',
);
/** The longest note a label keeps here. */
const NOTE_MAX = 500;
const noteBox = ref<HTMLTextAreaElement | null>(null);
const topOfItem = ref<HTMLElement | null>(null);

const criteria = computed(() => item.value?.criteria ?? []);
const allAnswered = computed(() => criteria.value.length > 0 && criteria.value.every((c) => answers[c.id]));
/** Still to label in this set, skipped ones included. */
const left = computed(() => queue.value?.length ?? 0);
const setFile = computed(() => SETS.find((s) => s.set === set.value)?.file ?? '');

function reset() {
  for (const k of Object.keys(answers)) delete answers[k];
  note.value = '';
  active.value = 0;
  saveError.value = null;
}
watch(set, () => {
  index.value = 0;
  skippedCount.value = 0;
  reset();
});

/** "7 of 30": this item's place in the queue as it loaded. */
const total = computed(() => data.value?.[set.value]?.length ?? 0);
const position = computed(() => Math.min(total.value - left.value + index.value + 1, total.value));

/** The next item starts at its top, with focus on its heading for screen readers. After a save the
 *  saved item has left the queue, so the next one is already at this place; a skip moves on. */
async function toNext(skipped: boolean) {
  if (skipped) index.value += 1;
  reset();
  await nextTick();
  topOfItem.value?.scrollIntoView?.({ block: 'start' });
  topOfItem.value?.focus({ preventScroll: true });
}

/** New trials may have finished since the queue loaded: fetch it again. The API's queue leaves out
 *  what is labelled, so this visit's saves start afresh. */
async function loadMore() {
  await reload();
  for (const s of SETS) savedIds[s.set].splice(0);
  index.value = 0;
  skippedCount.value = 0;
  unsureSaved.value = 0;
  reset();
}

function choose(criterionIndex: number, value: LabelValue) {
  const c = criteria.value[criterionIndex];
  if (!c) return;
  answers[c.id] = answers[c.id] === value ? undefined : value;
  active.value = criterionIndex;
}

/** Takes the id as typed (in lower case, without spaces around it). A new id loads that person's
 *  own queue; this visit's counts start again. */
async function confirmRater() {
  const id = raterFrom(raterDraft.value);
  if (!id) {
    raterError.value = raterDraft.value.trim()
      ? 'Use 1 to 40 lower-case letters, digits, dashes or underscores, with no spaces.'
      : 'Type the id you label under to start.';
    return;
  }
  raterError.value = null;
  rememberRater(id);
  editingRater.value = false;
  if (id === rater.value) return;
  rater.value = id;
  await loadMore();
}

function changeRater() {
  raterDraft.value = rater.value ?? '';
  raterError.value = null;
  editingRater.value = true;
  void nextTick(() => raterInput.value?.focus());
}

function keepRater() {
  raterError.value = null;
  editingRater.value = false;
}

async function saveAndNext() {
  const current = item.value;
  const who = rater.value;
  // Every label is saved under the id of the person giving it.
  if (!current || !who || !allAnswered.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    // Trimmed and capped; a note of only spaces is no note.
    const text = note.value.trim().slice(0, NOTE_MAX);
    for (const c of criteria.value) {
      await api.saveLabel({
        item_id: current.item_id,
        set: set.value,
        rater: who,
        criterion: c.id,
        value: answers[c.id] as LabelValue,
        note: text,
        ...(current.second_look ? { second_look: true } : {}),
      });
      if (answers[c.id] === 'unsure' && !current.second_look) unsureSaved.value += 1;
    }
    savedIds[set.value].push(current.item_id);
    await toNext(false);
  } catch (err) {
    saveError.value = errorText(err);
  } finally {
    saving.value = false;
  }
}

function skip() {
  skippedCount.value += 1;
  void toNext(true);
}

/**
 * 1, 2 and 3 answer the selected question and move to the next one; after the last, the focus
 * goes to the note. Enter saves and opens the next item, from anywhere but a button that does
 * something else; in the note, Shift+Enter starts a new line.
 */
function onKey(e: KeyboardEvent) {
  // Only the screen on the page answers: not one left over in memory, nor one not shown yet.
  if (!item.value || !noteBox.value?.isConnected || e.altKey || e.ctrlKey || e.metaKey) return;
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (e.key === 'Enter') {
    if (tag === 'SELECT' || (tag === 'TEXTAREA' && e.shiftKey)) return;
    if (tag === 'BUTTON' && !target?.closest('[data-test="criterion"]')) return;
    e.preventDefault();
    if (allAnswered.value && !saving.value) void saveAndNext();
    return;
  }
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  const v = VALUES.find((x) => x.key === e.key);
  if (!v) return;
  e.preventDefault();
  choose(active.value, v.value);
  if (active.value < criteria.value.length - 1) active.value += 1;
  else void nextTick(() => noteBox.value?.focus());
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
  if (editingRater.value) raterInput.value?.focus();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const setLabel = (s: LabelSet, name: string) => {
  const q = remainingOf(s);
  return q ? `${name}, ${q.length} to go` : name;
};
const purpose = computed(() => SETS.find((s) => s.set === set.value)?.purpose ?? '');

/** Tool arguments and results arrive as JSON text (the contract) or, from older data, as values. */
function pretty(v: unknown): string {
  if (typeof v !== 'string') return JSON.stringify(v, null, 2);
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}
const paragraphs = (text: string) => text.split(/\n{2,}/);
/** Where the tool calls go: before the agent's first reply, or after the conversation when the
 *  agent never replied, so its work is shown either way. */
const firstReply = computed(() => item.value?.transcript.findIndex((m) => m.role === 'assistant') ?? -1);
const noteLeft = computed(() => NOTE_MAX - note.value.length);
/** The agent's reply as it reads: bold, bullets and numbered steps, as text (no HTML). */
const blocks = (text: string) => mdBlocks(text);
</script>

<template>
  <div class="head-row">
    <div class="page-head">
      <h1 tabindex="-1">
        Label outputs
      </h1>
      <p
        class="lede"
        data-test="set-purpose"
      >
        {{ purpose }}
        <!-- While this set has items to go, this page links nowhere near the judge's verdicts and says to label first, so labelling stays blind. -->
        <span
          v-if="queue && left > 0"
          data-test="judge-later"
        >Label these before you open the Judge page: the judge's reasons there can steer your labels ({{ left }} to go).</span>
        <a
          v-else-if="!loading && rater && !editingRater"
          :href="href.judge()"
          data-test="judge-link"
        >See judge agreement</a>
      </p>
      <p
        v-if="calibrating"
        class="caveat"
        data-test="calibrate-banner"
      >
        <AppIcon
          name="info"
          :size="14"
        />
        <span><strong class="caveat-lead">You're calibrating a judge.</strong> These outputs were picked so its passes and fails are balanced. You won't see its verdicts.</span>
      </p>
      <p
        v-if="rater && !editingRater"
        class="rater-line small"
        data-test="rater"
      >
        <span>Labelling as <strong
          class="mono"
          data-test="rater-id"
        >{{ rater }}</strong></span>
        <button
          type="button"
          class="btn btn--quiet btn--slim"
          :disabled="saving"
          data-test="rater-change"
          @click="changeRater"
        >
          Change
        </button>
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

  <!-- Who is labelling. Asked before anything loads, shown while labelling, and changeable. -->
  <form
    v-if="editingRater"
    class="panel panel--pad rater-form"
    data-test="rater-form"
    novalidate
    @submit.prevent="confirmRater"
  >
    <label class="field">
      <span class="strong">Labelling as</span>
      <input
        ref="raterInput"
        v-model="raterDraft"
        type="text"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        placeholder="Your id, such as your first name"
        aria-describedby="rater-hint"
        :aria-invalid="raterError ? 'true' : undefined"
        data-test="rater-input"
      >
      <span
        id="rater-hint"
        class="secondary smaller"
      >Lower-case letters, digits, dashes or underscores, up to 40. Your labels are saved under this id, and the queue shows only what you have not labelled yet. This browser remembers it.</span>
    </label>
    <p
      v-if="raterError"
      class="error small"
      role="alert"
      data-test="rater-error"
    >
      {{ raterError }}
    </p>
    <div class="rater-buttons">
      <button
        type="submit"
        class="btn"
        data-test="rater-save"
      >
        {{ rater ? 'Label as this id' : 'Start labelling' }}
      </button>
      <button
        v-if="rater"
        type="button"
        class="btn btn--quiet"
        data-test="rater-keep"
        @click="keepRater"
      >
        Keep {{ rater }}
      </button>
    </div>
  </form>

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
      data-test="progress"
    ><template v-if="item">{{ position }} of {{ total }}</template><template v-else>{{ total }} of {{ total }}</template><template v-if="savedCount || skippedCount"> · {{ savedCount }} saved<template v-if="skippedCount">, {{ skippedCount }} skipped</template></template></span>
  </div>

  <LoadState
    v-if="rater && !editingRater"
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
    <div
      v-else-if="!item"
      class="panel empty"
      role="status"
      data-test="queue-empty"
    >
      <p>
        {{ total ? `All ${total} in this queue done${savedCount ? `: ${savedCount} saved` : ''}${skippedCount ? `, ${skippedCount} skipped` : ''}.` : 'Nothing to label in this set yet.' }}
        {{ secondLookNote }}Trials that finish later join the queue, except trials on a fake model (their replies are a script, not an agent's) and the shipped example's, which are never labelled here.
      </p>
      <button
        type="button"
        class="btn btn--quiet"
        data-test="load-more"
        @click="loadMore"
      >
        {{ unsureSaved ? 'Take the second look' : 'Check for more' }}
      </button>
    </div>
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
          ref="topOfItem"
          class="section-title"
          :class="{ mono: item.task_id }"
          tabindex="-1"
        >
          {{ item.task_id ?? 'The output to label' }}
        </h2>
        <p
          v-if="item.task_summary"
          class="secondary small summary"
        >
          {{ item.task_summary }}
        </p>
        <p
          v-if="item.second_look"
          class="caveat second-look"
          data-test="second-look"
        >
          <span><strong class="caveat-lead">Second look:</strong> you marked {{ item.criteria.length === 1 ? 'this question' : 'these questions' }} "Not sure" before. Give a firm answer if you can; "Not sure" again leaves {{ item.criteria.length === 1 ? 'it' : 'them' }} out of the judge's agreement check, and {{ item.criteria.length === 1 ? 'it does' : 'they do' }} not come back.</span>
        </p>
        <template
          v-for="(m, i) in item.transcript"
          :key="i"
        >
          <details
            v-if="i === firstReply && item.tool_calls.length"
            class="disclosure"
            data-test="tool-calls"
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
            <template v-if="m.role === 'assistant'">
              <p
                v-for="(b, bi) in blocks(m.content)"
                :key="bi"
                :class="['bubble-text', `md md--${b.kind}`]"
                :style="b.depth ? { paddingLeft: `${b.depth * 18 + 18}px` } : undefined"
              >
                <template
                  v-for="(part, pi) in b.parts"
                  :key="pi"
                >
                  <strong v-if="part.bold">{{ part.text }}</strong>
                  <template v-else>
                    {{ part.text }}
                  </template>
                </template>
              </p>
            </template>
            <template v-else>
              <p
                v-for="(p, pi) in paragraphs(m.content)"
                :key="pi"
                class="bubble-text"
              >
                {{ p }}
              </p>
            </template>
          </article>
        </template>
        <!-- The agent never replied: its tool calls are all it did, so they show open, after the client's words. -->
        <template v-if="firstReply === -1">
          <details
            v-if="item.tool_calls.length"
            class="disclosure"
            open
            data-test="tool-calls"
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
          <p
            class="panel no-answer small"
            data-test="no-answer"
          >
            <strong>The agent gave no final answer.</strong> {{ item.tool_calls.length ? 'Its tool calls above are all it did.' : 'It made no tool calls either.' }}
          </p>
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
          <p
            class="judgment-progress num"
            data-test="item-progress"
          >
            {{ position }} of {{ total }}
          </p>
          <p class="secondary small hint">
            Press 1, 2 or 3 to answer, type a note, then Enter to save and open the next.
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
              {{ c.text }}
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
                <kbd aria-hidden="true">{{ v.key }}</kbd>{{ v.text }}
              </button>
            </div>
          </fieldset>
        </div>
        <label class="field small">
          <span class="strong">Note, one line on why</span>
          <textarea
            ref="noteBox"
            v-model="note"
            rows="2"
            :maxlength="NOTE_MAX"
            placeholder="What made you decide, in a sentence"
            aria-describedby="note-hint"
            data-test="label-note"
          />
          <span
            id="note-hint"
            class="secondary smaller"
            data-test="note-hint"
          >Enter saves; Shift+Enter for a new line. Optional, up to {{ NOTE_MAX }} characters<template v-if="noteLeft < 100">, {{ noteLeft }} left</template>.</span>
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
            :disabled="!allAnswered || saving || !rater"
            data-test="save-label"
            @click="saveAndNext"
          >
            Save and next <kbd aria-hidden="true">Enter</kbd>
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
            Saved to {{ setFile }} as {{ rater }}, with today's date. Synthetic examples live in their own file and never appear here.
          </template>
        </p>
      </aside>
    </div>
  </LoadState>
</template>

<style scoped>
.rater-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 640px;
}

.rater-form input {
  max-width: 320px;
}

.rater-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.rater-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.btn--slim {
  min-height: 32px;
  padding: 0 12px;
}

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

/* One full-width button per answer, stacked: big targets that never wrap their words. */
.answers {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}

/* Big targets: one press per item. The key that answers is printed on each. */
.answer {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  min-height: 52px;
  padding: 0 14px;
  white-space: nowrap;
  border: 1px solid var(--rule-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 17px;
  cursor: pointer;
}

kbd {
  display: inline-block;
  min-width: 1.6em;
  padding: 0 4px;
  border: 1px solid var(--rule);
  border-radius: 4px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-2);
  background: var(--surface-muted);
}

.btn kbd {
  margin-left: 6px;
  color: inherit;
  background: transparent;
  border-color: currentColor;
}

.judgment-progress {
  margin: 2px 0 0;
  font-size: 22px;
  font-weight: 600;
}

.md--heading {
  font-weight: 600;
}

.md--item {
  position: relative;
  padding-left: 18px;
}

.md--item::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0.65em;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ink-2);
}

.empty p {
  margin: 0 0 10px;
}

.no-answer {
  padding: 12px 16px;
  border-radius: 10px;
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
