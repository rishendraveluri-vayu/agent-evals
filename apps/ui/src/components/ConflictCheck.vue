<script setup lang="ts">
/**
 * The pre-run conflict check (D33, D38): where our task prompt and settings contradict the
 * harness's own text. Reading the stored result is free; running a check is a REAL, PAID call to
 * Claude Sonnet 5.5 against a standing allowance, so the button asks first, says what it may
 * cost, and only shows when there is no stored result for the config as it is now.
 */
import { computed, ref, watch } from 'vue';
import { api } from '../api/client';
import { ApiError, errorText, errorWithFix } from '../api/errors';
import type { AllowanceView, ConflictCheckView, ConflictSeverity, RenderedPromptStatus } from '../api/types';
import { money, plainText, plural, relative, shortHash, wholeMoney } from '../lib/format';
import { harnessShort, modelName } from '../lib/names';
import AllowanceMeter from './AllowanceMeter.vue';
import AppIcon from './AppIcon.vue';

/** `renderedStatus` is where the config's rendered prompt stands, as the Rendered prompt panel read
 *  it: null while it is loading, `unknown` when it could not be read. The stored check is asked for
 *  only once the rendered prompt is ready, since the check reads it: before that the API can only
 *  answer 409, which would be noise on every visit. */
const props = defineProps<{ configHash: string; harness: string; renderedStatus: RenderedPromptStatus | 'unknown' | null; allowance: AllowanceView | null }>();
const emit = defineEmits<{ spent: [] }>();

type State = { kind: 'loading' } | { kind: 'none' } | { kind: 'needs-render' } | { kind: 'error'; text: string } | { kind: 'ready'; check: ConflictCheckView };
const state = ref<State>({ kind: 'loading' });
const confirming = ref(false);
const busy = ref(false);
/** A run that did not give a check: what to do, in plain words, and the API's own message behind Details. */
const runError = ref<{ text: string; raw: string | null } | null>(null);
const renderedReady = computed(() => props.renderedStatus === 'ready');

let loaded = false;
async function load() {
  loaded = true;
  try {
    // null: none stored yet (an API from before 5 Nov answered 404 no_conflict_check instead).
    const check = await api.conflictCheck(props.configHash);
    state.value = check ? { kind: 'ready', check } : { kind: 'none' };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'no_conflict_check') state.value = { kind: 'none' };
    else if (err instanceof ApiError && err.code === 'rendered_prompt_required') state.value = { kind: 'needs-render' };
    else state.value = { kind: 'error', text: plainText(errorWithFix(err)) };
  }
}
watch(
  () => props.renderedStatus,
  (status) => {
    if (status === null || loaded) return;
    // Ready: read the stored check. Not rendered (yet): no check can exist, so ask nothing.
    // Unknown: the rendered prompt could not be read, so ask, and say what the API answers.
    if (status === 'ready' || status === 'unknown') void load();
    else state.value = { kind: 'needs-render' };
  },
  { immediate: true },
);

/** LiteLLM refusing the checker for want of a provider key (401, x-api-key, an authentication error). */
const NO_KEY = /\b401\b|x-api-key|api[_ -]?key|authenticat/i;

/** A failed run in words. The API's raw message stays behind Details. */
function failureOf(err: unknown): { text: string; raw: string | null } {
  if (err instanceof ApiError && err.code === 'checker_call_failed' && NO_KEY.test(err.message)) {
    return { text: 'The prompt check needs an Anthropic key: add ANTHROPIC_API_KEY to .env and restart the stack (docker compose up -d). No check was stored.', raw: err.message };
  }
  if (err instanceof ApiError && err.code === 'checker_call_failed') {
    return { text: `The call to ${modelName('claude-sonnet-5-5')} did not go through, so no check was stored. Try again later.`, raw: err.message };
  }
  if (err instanceof ApiError && err.code === 'checker_output_invalid') {
    return { text: "The checker answered, but its reply could not be read, so no check was stored. The call was made and is counted in the platform's spend.", raw: err.message };
  }
  return { text: plainText(err instanceof ApiError ? errorWithFix(err) : errorText(err)), raw: null };
}

/** Only a person's click on the confirm button gets here. */
async function run() {
  busy.value = true;
  runError.value = null;
  try {
    const check = await api.runConflictCheck(props.configHash);
    state.value = { kind: 'ready', check };
    confirming.value = false;
    if (!check.cached) emit('spent');
  } catch (err) {
    runError.value = failureOf(err);
    confirming.value = false;
    if (err instanceof ApiError && (err.code === 'checker_output_invalid' || err.code === 'checker_call_failed')) emit('spent');
  } finally {
    busy.value = false;
  }
}

const SEVERITY: Record<ConflictSeverity, { word: string; order: number }> = {
  high: { word: 'High', order: 0 },
  medium: { word: 'Medium', order: 1 },
  low: { word: 'Low', order: 2 },
};
const findings = computed(() => {
  if (state.value.kind !== 'ready') return [];
  return [...state.value.check.conflicts].sort((a, b) => SEVERITY[a.severity].order - SEVERITY[b.severity].order);
});
const counts = computed(() => {
  const f = findings.value;
  return (['high', 'medium', 'low'] as const).map((s) => ({ s, n: f.filter((x) => x.severity === s).length })).filter((x) => x.n > 0);
});
const allowanceNow = computed(() => (state.value.kind === 'ready' ? state.value.check.allowance : props.allowance));
/** Before a call: the API reserves the worst case, input characters / 2 as tokens plus 2,000 output tokens, about $0.03 today. */
const worstCase = '$0.03';
const who = computed(() => harnessShort(props.harness));
</script>

<template>
  <section
    aria-labelledby="conflict-title"
    class="panel panel--pad conflicts"
    data-test="conflict-check"
  >
    <h2
      id="conflict-title"
      class="section-title"
    >
      Check for conflicts
    </h2>
    <p class="secondary small intro">
      Where our prompt or settings contradict what {{ who }} tells the model. A checker model reads the rendered prompt, our prompt and the settings, and quotes both sides of each conflict.
    </p>

    <p
      v-if="state.kind === 'loading'"
      class="secondary small"
      role="status"
    >
      Loading the stored check
    </p>
    <p
      v-else-if="state.kind === 'error'"
      class="error small"
      role="alert"
    >
      Could not load the conflict check: {{ state.text }}
    </p>
    <p
      v-else-if="state.kind === 'needs-render'"
      class="small"
      data-test="needs-render"
    >
      Render the prompt first: the check reads it.
    </p>

    <template v-else-if="state.kind === 'none'">
      <p
        class="small"
        data-test="check-state"
      >
        {{ runError ? 'No check is stored for this config: the last try did not finish.' : 'This config has not been checked yet.' }}
      </p>
      <div
        v-if="!confirming"
        class="row"
      >
        <button
          type="button"
          class="btn btn--quiet"
          :disabled="!renderedReady"
          data-test="run-check"
          @click="confirming = true"
        >
          {{ runError ? 'Try the check again…' : 'Check for conflicts…' }}
        </button>
        <span class="secondary smaller">A real, paid model call</span>
      </div>
      <div
        v-else
        class="confirm"
        role="group"
        aria-labelledby="confirm-title"
        data-test="confirm-check"
      >
        <p
          id="confirm-title"
          class="small strong"
        >
          <AppIcon
            name="alert"
            :size="14"
          /> This is a real call to {{ modelName('claude-sonnet-5-5') }}, paid from the platform's own allowance, not from any experiment.
        </p>
        <p class="small">
          It costs up to about {{ worstCase }}: the API reserves that worst case first and settles at the real cost<template v-if="allowanceNow && allowanceNow.calls">
            , which has averaged {{ money(allowanceNow.used_usd / allowanceNow.calls) }} a check so far
          </template>. The same input is never paid for twice.
          <template v-if="allowanceNow">
            {{ money(allowanceNow.remaining_usd) }} of the {{ wholeMoney(allowanceNow.limit_usd) }} allowance is left.
          </template>
        </p>
        <div class="row">
          <button
            type="button"
            class="btn"
            :disabled="busy"
            data-test="confirm-run-check"
            @click="run"
          >
            Run the paid check
          </button>
          <button
            type="button"
            class="btn btn--quiet"
            :disabled="busy"
            @click="confirming = false"
          >
            Cancel
          </button>
        </div>
      </div>
    </template>

    <template v-else-if="state.kind === 'ready'">
      <p
        v-if="state.check.skipped === 'no_harness_text'"
        class="small"
        data-test="check-skipped"
      >
        Nothing to check: {{ who }} adds no text of its own, so no call was made and it cost nothing.
      </p>
      <template v-else>
        <p
          class="small"
          data-test="check-summary"
        >
          <strong>{{ state.check.conflicts.length ? plural(state.check.conflicts.length, 'conflict') : 'No conflicts' }}</strong>
          <template v-if="counts.length">
            ({{ counts.map((c) => `${c.n} ${SEVERITY[c.s].word.toLowerCase()}`).join(', ') }})
          </template>
          found by {{ modelName(state.check.model) }}, checker {{ state.check.checker.id }} {{ state.check.checker.version }}, {{ relative(state.check.checked_at).toLowerCase() }}.
        </p>
        <ol
          v-if="findings.length"
          class="findings"
          data-test="findings"
        >
          <li
            v-for="(f, i) in findings"
            :key="i"
            class="finding"
            data-test="finding"
            :data-severity="f.severity"
          >
            <span
              class="pill pill--small severity"
              :class="`severity--${f.severity}`"
              data-test="severity"
            >{{ SEVERITY[f.severity].word }}</span>
            <div class="quotes">
              <div>
                <span class="secondary smaller block">{{ who }} says</span>
                <blockquote class="quote small">
                  “{{ f.harness_says }}”
                </blockquote>
              </div>
              <div>
                <span class="secondary smaller block">We say</span>
                <blockquote class="quote small">
                  “{{ f.we_say }}”
                </blockquote>
              </div>
            </div>
            <p class="small why">
              {{ f.why_it_matters }}
            </p>
          </li>
        </ol>
        <p
          v-if="state.check.notes"
          class="small secondary"
        >
          <strong>Checker's note:</strong> {{ state.check.notes }}
        </p>
      </template>
      <p
        class="small cost"
        data-test="check-cost"
      >
        <template v-if="state.check.skipped">
          Cost $0.
        </template>
        <template v-else>
          This check cost <span class="num">{{ state.check.cost_usd === null ? 'an amount LiteLLM never reported' : money(state.check.cost_usd) }}</span> {{ state.check.cached ? 'when it ran; showing the stored result, so this view spent nothing.' : 'when it ran.' }}
        </template>
        <span class="secondary"> Input <span class="mono">{{ shortHash(state.check.input_sha256) }}</span>: a change to the prompt, the harness text or the settings makes a new check.</span>
      </p>
    </template>

    <div
      v-if="runError"
      class="run-error"
      role="alert"
    >
      <p
        class="error small"
        data-test="check-error"
      >
        {{ runError.text }}
      </p>
      <details
        v-if="runError.raw"
        class="details small"
        data-test="check-error-details"
      >
        <summary>Details</summary>
        <pre class="code-block">{{ runError.raw }}</pre>
      </details>
    </div>

    <div
      v-if="allowanceNow"
      class="allowance-row small secondary"
    >
      <AllowanceMeter :allowance="allowanceNow" />
    </div>
  </section>
</template>

<style scoped>
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

.confirm {
  margin: 8px 0;
  padding: 12px 14px;
  border: 1px solid var(--rule-strong);
  border-left: 4px solid var(--ink);
  border-radius: 8px;
}

.confirm p {
  margin: 0 0 6px;
}

.strong {
  font-weight: 600;
}

.findings {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}

.finding {
  display: grid;
  gap: 6px;
  padding: 12px 0;
  border-top: 1px solid var(--rule-soft);
}

.quotes {
  display: grid;
  gap: 8px;
}

@media (min-width: 900px) {
  .quotes {
    grid-template-columns: 1fr 1fr;
  }
}

.quote {
  margin: 2px 0 0;
  padding: 6px 10px;
  border-left: 3px solid var(--rule-strong);
  background: var(--ground);
}

.why {
  margin: 0;
}

/* Severity is in the word; weight and fill add to it without a hue, so colour keeps meaning
   arms and grades. */
.severity {
  justify-self: start;
}

.severity--high {
  background: var(--primary);
  color: var(--on-primary);
}

.severity--medium {
  background: transparent;
  border: 1px solid var(--ink);
}

.severity--low {
  background: transparent;
  border: 1px solid var(--rule);
  font-weight: 500;
  color: var(--ink-2);
}

.cost {
  margin: 12px 0 4px;
}

.allowance-row {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--rule-soft);
}

.error {
  color: var(--error);
}

.run-error {
  margin: 8px 0;
}

.details > summary {
  cursor: pointer;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  color: var(--ink-2);
}
</style>
