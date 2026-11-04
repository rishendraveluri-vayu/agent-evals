<script setup lang="ts">
/**
 * The LLM judge for one experiment: whether real-model judging is approved, with which model, its
 * budget and what it has spent; approving it (a paid step, confirmed first, then a regrade), a
 * regrade, and revoking it. Approval mints a capped LiteLLM key for that experiment only
 * (docs/api-contract.md, Judge approval), so the judge can never spend past the budget.
 */
import { computed, ref } from 'vue';
import { api } from '../api/client';
import { errorWithFix } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { JudgeView, ModelView } from '../api/types';
import { optional, useLoad } from '../lib/async';
import { money, plainText, plural, relative, wholeMoney } from '../lib/format';
import { isFake } from '../lib/models';
import { modelName } from '../lib/names';
import AppIcon from './AppIcon.vue';

const props = defineProps<{
  experimentId: string;
  judge: JudgeView | null;
  /** Finished trials whose task has a judge check: what a regrade sends to the judge. */
  judgedTrials: number;
  /** Tasks in the experiment with a judge check. */
  judgedTasks: number;
}>();
/** Something changed on the API (an approval, a revoke, a regrade queued): read the experiment again. */
const emit = defineEmits<{ changed: [] }>();

const fixtures = isFixtureMode();
/** The API's own cap on a judge budget, in dollars. */
const BUDGET_MAX = 20;

/** Real models only: a judge on a scripted model would grade nothing. */
const { data: models } = useLoad(async () => (await optional(api.models(), [] as ModelView[])).filter((m) => !isFake(m.name)));

type Step = 'idle' | 'approve' | 'regrade';
const step = ref<Step>('idle');
const model = ref('');
const budget = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const done = ref<string | null>(null);

const budgetValue = computed(() => Number(budget.value.trim()));
const budgetProblem = computed(() => {
  const raw = budget.value.trim();
  if (!raw) return null;
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(budgetValue.value)) return `The budget is a dollar amount, such as 2 or 2.50; “${raw}” is not one.`;
  if (budgetValue.value <= 0 || budgetValue.value > BUDGET_MAX) return `The budget must be above $0 and at most $${BUDGET_MAX}.`;
  return null;
});
/** Why "Approve and judge" is off, in words; null when it is on. */
const approveBlocked = computed(() => {
  if (!model.value) return 'Pick the model the judge calls.';
  if (budgetProblem.value) return budgetProblem.value;
  if (!budget.value.trim()) return `Give a budget: the most judging may spend, at most $${BUDGET_MAX}.`;
  return null;
});

function open(next: Step) {
  step.value = next;
  error.value = null;
  done.value = null;
}

function regradeWords(queued: number, noGraders: number): string {
  const none = noGraders ? ` ${plural(noGraders, 'trial')} ${noGraders === 1 ? 'has' : 'have'} no graders and ${noGraders === 1 ? 'was' : 'were'} skipped.` : '';
  return `Regrade queued for ${plural(queued, 'finished trial')}: each trial page shows its new grades once they are in. No agent is run again.${none}`;
}

/** Only the confirmed "Approve and judge" click gets here: approve, then regrade. */
async function approve() {
  if (approveBlocked.value) return;
  busy.value = true;
  error.value = null;
  let approved = false;
  try {
    const a = await api.approveJudge(props.experimentId, { model: model.value, budget_usd: budgetValue.value });
    approved = true;
    const r = await api.regrade(props.experimentId);
    done.value = `Approved: ${modelName(a.model)}, with a ${wholeMoney(a.budget_usd)} budget. ${regradeWords(r.queued, r.no_graders)}`;
    step.value = 'idle';
  } catch (err) {
    error.value = approved
      ? `Judging is approved, but the regrade could not be queued: ${plainText(errorWithFix(err))} Use “Regrade with the judge” to try again.`
      : `Not approved: ${plainText(errorWithFix(err))}`;
    if (approved) step.value = 'idle';
  } finally {
    busy.value = false;
    if (approved) {
      emit('changed');
      window.dispatchEvent(new CustomEvent('evals:spend-changed'));
    }
  }
}

/** Only the confirmed "Regrade" click gets here. */
async function regrade() {
  busy.value = true;
  error.value = null;
  try {
    const r = await api.regrade(props.experimentId);
    done.value = regradeWords(r.queued, r.no_graders);
    step.value = 'idle';
    emit('changed');
  } catch (err) {
    error.value = `The regrade was not queued: ${plainText(errorWithFix(err))}`;
  } finally {
    busy.value = false;
  }
}

async function revoke() {
  busy.value = true;
  error.value = null;
  done.value = null;
  try {
    await api.revokeJudge(props.experimentId);
    done.value = 'Judging revoked: its key is deleted, so the judge makes no more calls. Grades it already gave stay.';
    step.value = 'idle';
    emit('changed');
    window.dispatchEvent(new CustomEvent('evals:spend-changed'));
  } catch (err) {
    error.value = `Not revoked, so judging is still approved: ${plainText(errorWithFix(err))}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    id="judge-panel"
    aria-labelledby="judge-title"
    class="panel panel--pad judge-panel"
    tabindex="-1"
    data-test="judge-panel"
  >
    <h2
      id="judge-title"
      class="section-title"
    >
      LLM judge
    </h2>
    <p class="secondary small intro">
      The judge is a model that grades the checks code cannot, such as whether the advice fits the client, from the conversation and tool calls alone. Each judged trial is a real model call, so judging costs money.
    </p>

    <template v-if="judge">
      <dl
        class="facts small"
        data-test="judge-facts"
      >
        <div>
          <dt>Judging</dt>
          <dd data-test="judge-state">
            Approved {{ relative(judge.approved_at).toLowerCase() }}
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd data-test="judge-model">
            {{ modelName(judge.model) }}
          </dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd
            class="num"
            data-test="judge-budget"
          >
            {{ wholeMoney(judge.budget_usd) }}
          </dd>
        </div>
        <div>
          <dt>Spent so far</dt>
          <dd
            class="num"
            data-test="judge-spent"
          >
            {{ judge.spend_usd === null ? 'Not readable from LiteLLM right now' : money(judge.spend_usd) }}
          </dd>
        </div>
      </dl>
      <div
        v-if="step !== 'regrade'"
        class="row"
      >
        <button
          type="button"
          class="btn btn--quiet"
          :disabled="busy"
          data-test="judge-regrade"
          @click="open('regrade')"
        >
          Regrade with the judge…
        </button>
        <button
          type="button"
          class="btn btn--quiet"
          :disabled="busy"
          data-test="judge-revoke"
          @click="revoke"
        >
          Revoke judging
        </button>
      </div>
      <div
        v-else
        class="confirm"
        role="group"
        aria-labelledby="regrade-confirm-title"
        data-test="judge-regrade-confirm"
      >
        <p
          id="regrade-confirm-title"
          class="small strong"
        >
          <AppIcon
            name="alert"
            :size="14"
          /> A paid step: the judge calls {{ modelName(judge.model) }} again for {{ plural(judgedTrials, 'finished trial') }} with a judge check.
        </p>
        <p class="small">
          It spends from the same {{ wholeMoney(judge.budget_usd) }} budget<template v-if="judge.spend_usd !== null">
            , {{ money(judge.spend_usd) }} of it spent so far
          </template>, and stops there. No agent is run again.
        </p>
        <div class="row">
          <button
            type="button"
            class="btn"
            :disabled="busy"
            data-test="judge-regrade-go"
            @click="regrade"
          >
            Regrade
          </button>
          <button
            type="button"
            class="btn btn--quiet"
            :disabled="busy"
            @click="open('idle')"
          >
            Cancel
          </button>
        </div>
      </div>
    </template>

    <template v-else>
      <p
        class="small"
        data-test="judge-state"
      >
        <strong>Not approved.</strong>
        {{ judgedTasks ? `The judge checks on ${plural(judgedTasks, 'task')} stay ungraded (“Not judged”) until judging is approved.` : 'No task in this experiment has a judge check, so there is nothing for a judge to grade.' }}
      </p>
      <button
        v-if="step !== 'approve' && judgedTasks"
        type="button"
        class="btn btn--quiet"
        data-test="judge-approve-open"
        @click="open('approve')"
      >
        Approve the judge…
      </button>
      <form
        v-else-if="step === 'approve'"
        class="approve"
        novalidate
        data-test="judge-approve"
        @submit.prevent="approve"
      >
        <div class="fields">
          <label class="field">
            <span class="strong small">Model the judge calls</span>
            <select
              v-model="model"
              data-test="judge-model-select"
            >
              <option
                value=""
                disabled
              >Pick a model</option>
              <option
                v-for="m in models ?? []"
                :key="m.name"
                :value="m.name"
              >{{ modelName(m.name) }}</option>
            </select>
            <span
              v-if="models && !models.length"
              class="secondary smaller"
            >No real model is set up in LiteLLM, so there is none to pick.</span>
          </label>
          <label class="field">
            <span class="strong small">Budget, in dollars</span>
            <input
              v-model="budget"
              type="text"
              inputmode="decimal"
              class="num budget"
              placeholder="2.00"
              maxlength="8"
              :aria-invalid="budgetProblem ? 'true' : undefined"
              :aria-describedby="budgetProblem ? 'judge-budget-problem' : 'judge-budget-hint'"
              data-test="judge-budget-input"
            >
            <span
              v-if="budgetProblem"
              id="judge-budget-problem"
              class="problem smaller"
              data-test="judge-budget-problem"
            >{{ budgetProblem }}</span>
            <span
              v-else
              id="judge-budget-hint"
              class="secondary smaller"
            >The most judging may spend on this experiment, at most ${{ BUDGET_MAX }}. Its key stops there.</span>
          </label>
        </div>
        <div
          class="confirm"
          role="group"
          aria-labelledby="approve-confirm-title"
          data-test="judge-confirm"
        >
          <p
            id="approve-confirm-title"
            class="small strong"
          >
            <AppIcon
              name="alert"
              :size="14"
            /> A paid step: approving sends {{ plural(judgedTrials, 'finished trial') }} to {{ model ? modelName(model) : 'the model you pick' }}, one call per judge check, at once.
          </p>
          <p class="small">
            It never spends more than {{ budgetProblem || !budget.trim() ? 'the budget' : wholeMoney(budgetValue) }}. A regrade starts right after; no agent is run again, and earlier grades are kept.
          </p>
          <p
            v-if="fixtures"
            class="small secondary"
          >
            Sample data: here nothing is minted and no model is called.
          </p>
          <div class="row">
            <button
              type="submit"
              class="btn"
              :disabled="busy || !!approveBlocked"
              :aria-describedby="approveBlocked ? 'judge-approve-blocked' : undefined"
              data-test="judge-approve-go"
            >
              Approve and judge
            </button>
            <button
              type="button"
              class="btn btn--quiet"
              :disabled="busy"
              data-test="judge-approve-cancel"
              @click="open('idle')"
            >
              Cancel
            </button>
          </div>
          <p
            v-if="approveBlocked"
            id="judge-approve-blocked"
            class="secondary smaller"
            data-test="judge-approve-blocked"
          >
            {{ approveBlocked }}
          </p>
        </div>
      </form>
    </template>

    <p
      v-if="done"
      class="small done"
      role="status"
      data-test="judge-done"
    >
      {{ done }}
    </p>
    <p
      v-if="error"
      class="small error"
      role="alert"
      data-test="judge-error"
    >
      {{ error }}
    </p>
  </section>
</template>

<style scoped>
.judge-panel:focus {
  outline: none;
}

.intro {
  margin: 4px 0 14px;
  max-width: 72ch;
}

.facts {
  margin: 0 0 12px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px 20px;
}

.facts dt {
  color: var(--ink-2);
  font-size: 13px;
}

.facts dd {
  margin: 0;
  font-weight: 500;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 8px 0;
}

.approve {
  display: grid;
  gap: 12px;
}

.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 20px;
  max-width: 640px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.budget {
  max-width: 160px;
}

.strong {
  font-weight: 600;
}

/* A paid step: ink rule on the left, an alert icon and the words; no pass or fail hue. */
.confirm {
  padding: 12px 14px;
  border: 1px solid var(--rule-strong);
  border-left: 4px solid var(--ink);
  border-radius: 8px;
  max-width: 72ch;
}

.confirm p {
  margin: 0 0 6px;
}

.problem,
.error {
  color: var(--error);
}

.done {
  margin-top: 8px;
}

.error {
  margin-top: 8px;
}
</style>
