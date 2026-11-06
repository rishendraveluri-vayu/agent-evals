<script setup lang="ts">
/**
 * The LLM judge for one experiment: whether real-model judging is approved, with which model, its
 * budget and what it has spent; approving it (a paid step, confirmed first, then a regrade), a
 * regrade, and revoking it. Approval mints a capped LiteLLM key for that experiment only
 * (docs/api-contract.md, Judge approval), so the judge can never spend past the budget.
 *
 * Under it, how far to trust the experiment's judges (D83), and a way to calibrate them: label a
 * few of its outputs blind, in an order that balances the judge's passes and fails.
 */
import { computed, ref } from 'vue';
import { api } from '../api/client';
import { errorWithFix } from '../api/errors';
import { isFixtureMode } from '../api/mode';
import type { JudgeTrust, JudgeView, ModelView } from '../api/types';
import { optional, useLoad } from '../lib/async';
import { money, plainText, plural, relative, wholeMoney } from '../lib/format';
import { isFake } from '../lib/models';
import { modelName } from '../lib/names';
import { missingKey } from '../lib/runSetup';
import { rubricName } from '../lib/trust';
import { href } from '../router';
import AppIcon from './AppIcon.vue';
import TrustBadge from './TrustBadge.vue';

const props = defineProps<{
  experimentId: string;
  judge: JudgeView | null;
  /** Finished trials whose task has a judge check: what a regrade sends to the judge. */
  judgedTrials: number;
  /** Tasks in the experiment with a judge check. */
  judgedTasks: number;
  /** Which arms ran on a fake model ("Both arms", "Arm A"), or null: their outputs are scripted,
   *  so a real judge would spend real money grading made-up text. Approving then asks twice. */
  fakeArms?: string | null;
  /** This experiment's judges and how far to trust each (D83); null when it could not be read. */
  trust?: JudgeTrust[] | null;
  /** The labels page, calibrating this experiment's judge. */
  calibrateHref?: string;
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
/** Set once the second question is answered yes: judge made-up outputs with a real model anyway. */
const fakeAsked = ref(false);
const fakeConfirmed = ref(false);

const budgetValue = computed(() => Number(budget.value.trim()));
const budgetProblem = computed(() => {
  const raw = budget.value.trim();
  if (!raw) return null;
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(budgetValue.value)) return `The budget is a dollar amount, such as 2 or 2.50; “${raw}” is not one.`;
  if (budgetValue.value <= 0 || budgetValue.value > BUDGET_MAX) return `The budget must be above $0 and at most $${BUDGET_MAX}.`;
  return null;
});
/** The .env variable a listed model needs and lacks (GET /models' key_set), as the Build and Run
 *  screens read it: null when it is set or the API could not tell. */
const keyOf = (name: string) => missingKey(name, models.value ?? []);
/** "needs ANTHROPIC_API_KEY in .env, then docker compose up -d", for the picked model. */
const keyProblem = computed(() => {
  const key = model.value ? keyOf(model.value) : null;
  return key ? `${modelName(model.value)} needs ${key} in .env, then docker compose up -d. Until then the judge cannot call it, so judging stays off.` : null;
});

/** Why "Approve and judge" is off, in words; null when it is on. */
const approveBlocked = computed(() => {
  if (!model.value) return 'Pick the model the judge calls.';
  if (keyProblem.value) return keyProblem.value;
  if (budgetProblem.value) return budgetProblem.value;
  if (!budget.value.trim()) return `Give a budget: the most judging may spend, at most $${BUDGET_MAX}.`;
  return null;
});

function open(next: Step) {
  step.value = next;
  error.value = null;
  done.value = null;
  fakeAsked.value = false;
  fakeConfirmed.value = false;
}

/** "Approve and judge": on an experiment with fake-model arms it asks once more first. */
function submitApprove() {
  if (approveBlocked.value || busy.value) return;
  if (props.fakeArms && !fakeConfirmed.value) {
    fakeAsked.value = true;
    return;
  }
  void approve();
}

function confirmFake() {
  fakeConfirmed.value = true;
  fakeAsked.value = false;
  void approve();
}

function regradeWords(queued: number, noGraders: number): string {
  const none = noGraders ? ` ${plural(noGraders, 'trial')} ${noGraders === 1 ? 'has' : 'have'} no graders and ${noGraders === 1 ? 'was' : 'were'} skipped.` : '';
  return `Regrade queued for ${plural(queued, 'finished trial')}: each trial page shows its new grades once they are in. No agent is run again.${none}`;
}

/** Only the confirmed "Approve and judge" click gets here (and, on fake-model arms, the second
 *  yes): approve, then regrade. */
async function approve() {
  if (approveBlocked.value) return;
  if (props.fakeArms && !fakeConfirmed.value) return;
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
        <p
          v-if="fakeArms"
          class="small fake-warning"
          data-test="judge-fake-warning"
        >
          <strong>{{ fakeArms }} ran on a fake model:</strong> the judge would grade scripted test replies, with real money.
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
        @submit.prevent="submitApprove"
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
              >{{ modelName(m.name) }}{{ keyOf(m.name) ? ` (needs ${keyOf(m.name)} in .env)` : '' }}</option>
            </select>
            <span
              v-if="models && !models.length"
              class="secondary smaller"
            >No real model is set up in LiteLLM, so there is none to pick.</span>
            <span
              v-else-if="keyProblem"
              id="judge-key-problem"
              class="problem smaller"
              data-test="judge-key-problem"
            >{{ keyProblem }}</span>
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
            v-if="fakeArms"
            class="small fake-warning"
            data-test="judge-fake-warning"
          >
            <AppIcon
              name="alert"
              :size="14"
            /> <strong>{{ fakeArms }} ran on a fake model:</strong> those outputs are scripted test replies, not an agent’s answers. A real judge would spend real money grading made-up text, and its grades would say nothing about any agent.
          </p>
          <p
            v-if="fixtures"
            class="small secondary"
          >
            Sample data: here nothing is minted and no model is called.
          </p>
          <div
            v-if="fakeAsked"
            class="confirm again"
            role="alertdialog"
            aria-labelledby="judge-fake-again"
            data-test="judge-fake-confirm"
          >
            <p
              id="judge-fake-again"
              class="small strong"
            >
              Judge made-up outputs with a real, paid model anyway?
            </p>
            <div class="row">
              <button
                type="button"
                class="btn"
                :disabled="busy"
                data-test="judge-fake-go"
                @click="confirmFake"
              >
                Yes, spend on them anyway
              </button>
              <button
                type="button"
                class="btn btn--quiet"
                :disabled="busy"
                data-test="judge-fake-cancel"
                @click="open('idle')"
              >
                Cancel
              </button>
            </div>
          </div>
          <div
            v-else
            class="row"
          >
            <button
              type="submit"
              class="btn"
              :disabled="busy || !!approveBlocked"
              :aria-describedby="keyProblem ? 'judge-key-problem' : approveBlocked ? 'judge-approve-blocked' : undefined"
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
          <!-- A missing key is said once, under the model it belongs to. -->
          <p
            v-if="approveBlocked && approveBlocked !== keyProblem"
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

    <section
      v-if="trust"
      class="trust-section"
      aria-labelledby="judge-trust-title"
      data-test="judge-trust"
    >
      <h3
        id="judge-trust-title"
        class="sub-title"
      >
        How far to trust it
      </h3>
      <p
        class="small trust-why"
        data-test="judge-trust-why"
      >
        A judge is only as good as its agreement with people. Label a few of its outputs blind, without seeing its verdicts, and its agreement updates as you go.
      </p>
      <ul
        v-if="trust.length"
        class="trust-list"
      >
        <li
          v-for="j in trust"
          :key="`${j.judge_model} ${j.rubric}`"
          class="trust-row"
          data-test="judge-trust-row"
        >
          <span class="trust-head">
            <span
              class="small"
              data-test="judge-trust-name"
            ><span class="strong">{{ modelName(j.judge_model) }}</span>, rubric <span class="mono">{{ rubricName(j.rubric) }}</span></span>
            <TrustBadge :status="j.status" />
          </span>
          <span
            class="small secondary"
            data-test="judge-trust-summary"
          >{{ plainText(j.summary) }}</span>
        </li>
      </ul>
      <p
        v-else
        class="small secondary"
        data-test="judge-trust-none"
      >
        No judge has graded this experiment's outputs yet, so there is nothing to measure. Once one has, how far to trust it shows here.
      </p>
      <div
        v-if="trust.length && calibrateHref"
        class="row"
      >
        <a
          class="btn btn--quiet"
          :href="calibrateHref"
          data-test="judge-calibrate"
        >Calibrate this judge</a>
        <a
          :href="href.judge()"
          class="small"
          data-test="judge-trust-link"
        >Every question, on the judge page</a>
      </div>
    </section>
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
  grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr));
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
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
}

.fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
  gap: 12px 20px;
  max-width: 640px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
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

/* The second question, inside the first confirmation: asked only for fake-model arms. */
.confirm.again {
  margin-top: 6px;
  border-left-color: var(--error);
}

.fake-warning {
  font-weight: 500;
}

.problem,
.error {
  color: var(--error);
}

.done {
  margin-top: 8px;
}

.trust-section {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--rule-soft);
}

.sub-title {
  font-size: 15px;
}

.trust-why {
  margin: 4px 0 10px;
  max-width: 72ch;
}

.trust-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.trust-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 72ch;
}

.trust-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}

.error {
  margin-top: 8px;
}
</style>
