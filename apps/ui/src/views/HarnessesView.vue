<script setup lang="ts">
import { computed } from 'vue';
import { api } from '../api/client';
import { SETTING_NAMES } from '../api/types';
import AppIcon from '../components/AppIcon.vue';
import LoadState from '../components/LoadState.vue';
import { useLoad } from '../lib/async';
import { coverageText, matrixCell } from '../lib/capabilities';
import { shortRef, splitIdents } from '../lib/format';
import { harnessName, harnessShort, settingLabel } from '../lib/names';

const { data, error, loading } = useLoad(() => api.harnesses());

const differences = computed(() => (data.value ?? []).flatMap((h) => h.capabilities.known_differences.map((text, i) => ({ key: `${h.name}-${i}`, harness: h.name, text }))));

const STEPS = [
  { title: 'Create the folder', cmd: 'make new-harness NAME=crewai' },
  { title: 'Write setup and run_turn', cmd: 'workers/crewai/src/crewai_adapter/adapter.py' },
  { title: 'Probe what reaches the model', cmd: 'make probe-harness NAME=crewai' },
  { title: 'Pass the gate tests, then review', cmd: 'make test-harness NAME=crewai' },
];
</script>

<template>
  <div class="page-head">
    <h1 tabindex="-1">
      Harnesses
    </h1>
    <p class="lede">
      Every harness plugs in as an adapter on the same contract. What each one supports is measured by sending requests to a fake model, not taken from its documentation.
    </p>
  </div>

  <LoadState
    :loading="loading"
    :error="error"
    what="the harnesses"
  >
    <template v-if="data">
      <section
        aria-labelledby="matrix"
        class="stack"
      >
        <div class="head-row head-row--baseline">
          <h2
            id="matrix"
            class="section-title"
          >
            What reaches the model
          </h2>
          <div class="key smaller secondary">
            <span><span class="probed"><AppIcon
              name="check"
              :size="12"
            />Probed</span>: seen in a request</span>
            <span><span class="declared">Declared</span>: a request cannot show it</span>
            <span><span class="none">Not supported</span>: the harness has no such feature</span>
            <span><span class="pending">Not probed yet</span>: no request sent to check it</span>
          </div>
        </div>
        <!-- Narrower than the table's five harness columns: one card per harness, every setting
             in it, so no harness sits off to the side. -->
        <div
          class="matrix-cards"
          data-test="capability-cards"
        >
          <section
            v-for="h in data"
            :key="h.name"
            class="panel harness-card"
            :aria-labelledby="`harness-card-${h.name}`"
            data-test="harness-card"
          >
            <h3
              :id="`harness-card-${h.name}`"
              class="card-title"
            >
              {{ harnessName(h.name) }} <span class="secondary smaller mono">{{ shortRef(h.ref) }}</span>
            </h3>
            <p class="result-detail card-coverage">
              {{ coverageText(h) }}
            </p>
            <dl class="card-settings">
              <div
                v-for="name in SETTING_NAMES"
                :key="name"
                :data-test="`card-${h.name}-${name}`"
              >
                <dt>{{ settingLabel(name) }}</dt>
                <dd>
                  <span :class="matrixCell(h.capabilities.settings[name]).kind"><AppIcon
                    v-if="matrixCell(h.capabilities.settings[name]).kind === 'probed'"
                    name="check"
                    :size="12"
                  />{{ matrixCell(h.capabilities.settings[name]).text }}</span>
                  <span
                    v-if="matrixCell(h.capabilities.settings[name]).note"
                    class="block secondary smaller"
                  >{{ matrixCell(h.capabilities.settings[name]).note }}</span>
                </dd>
              </div>
            </dl>
          </section>
        </div>
        <div class="table-wrap matrix-wrap">
          <table
            class="table matrix"
            data-test="capability-matrix"
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  class="setting-col"
                >
                  Setting
                </th>
                <th
                  v-for="h in data"
                  :key="h.name"
                  scope="col"
                  class="harness-col"
                >
                  <span class="block strong-head">{{ harnessName(h.name) }}</span>
                  <span class="block secondary smaller mono">{{ shortRef(h.ref) }}</span>
                  <span
                    class="result-detail coverage"
                    data-test="coverage"
                  >{{ coverageText(h) }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="name in SETTING_NAMES"
                :key="name"
              >
                <th
                  scope="row"
                  class="strong"
                >
                  {{ settingLabel(name) }}
                </th>
                <td
                  v-for="h in data"
                  :key="h.name"
                  :data-test="`cell-${h.name}-${name}`"
                >
                  <span :class="matrixCell(h.capabilities.settings[name]).kind"><AppIcon
                    v-if="matrixCell(h.capabilities.settings[name]).kind === 'probed'"
                    name="check"
                    :size="12"
                  />{{ matrixCell(h.capabilities.settings[name]).text }}</span>
                  <span
                    v-if="matrixCell(h.capabilities.settings[name]).note"
                    class="block secondary smaller"
                  >{{ matrixCell(h.capabilities.settings[name]).note }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="split">
        <section
          aria-labelledby="diffs"
          class="grow stack"
        >
          <h2
            id="diffs"
            class="section-title"
          >
            Known differences that can affect a comparison
          </h2>
          <p class="secondary small">
            Kept as each harness ships them, never stripped, and recorded so a result can be read with them in mind.
          </p>
          <ul class="diffs">
            <li
              v-for="d in differences"
              :key="d.key"
            >
              <span class="strong">{{ harnessShort(d.harness) }}</span>
              <span data-test="difference-text"><template
                v-for="(part, pi) in splitIdents(d.text)"
                :key="pi"
              ><span
                v-if="part.ident"
                class="mono"
              >{{ part.text }}</span><template v-else>{{ part.text }}</template></template></span>
            </li>
          </ul>
        </section>

        <section
          aria-labelledby="add"
          class="side panel panel--pad"
        >
          <h2
            id="add"
            class="section-title"
          >
            Add a harness
          </h2>
          <p class="secondary small add-note">
            No change to the platform: one folder, two methods.
          </p>
          <ol class="steps">
            <li
              v-for="(s, i) in STEPS"
              :key="s.cmd"
            >
              <span
                class="step-n"
                aria-hidden="true"
              >{{ i + 1 }}</span>
              <span><span class="block strong">{{ s.title }}</span><code class="block secondary smaller cmd">{{ s.cmd }}</code></span>
            </li>
          </ol>
        </section>
      </div>
    </template>
  </LoadState>
</template>

<style scoped>
.head-row--baseline {
  align-items: baseline;
}

.key {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}

/* Columns size to their content, so each harness's coverage line keeps to one line; the longest
   one is wider than an equal share of the table. */
.matrix {
  min-width: 1040px;
}

/* The cards stand in for the table where it would not fit the page (1040 px of table inside the
   page's padding): a phone or a tablet. */
.matrix-cards {
  display: none;
}

@media (max-width: 1099px) {
  .matrix-wrap {
    display: none;
  }

  .matrix-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
    gap: 16px;
    align-items: start;
  }
}

.harness-card {
  padding: 18px 20px 6px;
  min-width: 0;
}

.card-title {
  font-size: 16px;
}

.card-coverage {
  margin-top: 4px;
}

.card-settings {
  margin: 10px 0 0;
}

.card-settings > div {
  padding: 10px 0;
  border-top: 1px solid var(--rule-soft);
  overflow-wrap: anywhere;
}

/* The setting is the label; how it is known is the value, as in the table's cells. */
.card-settings dt {
  font-size: 14px;
  color: var(--ink-2);
}

.card-settings dd {
  margin: 2px 0 0;
}

.setting-col {
  width: 180px;
}

.harness-col {
  vertical-align: top;
}

.strong-head {
  font-weight: 600;
  color: var(--ink);
}

/* How each setting is known, in plain grey words under the version: a count, not a status. */
.coverage {
  display: block;
  margin-top: 6px;
  font-weight: 400;
  white-space: nowrap;
}

.block {
  display: block;
}

.strong {
  font-weight: 500;
}

/* Probed is the strongest evidence, but not a pass: ink and a check mark, no green. */
.probed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ink);
  font-weight: 500;
}

.declared {
  color: var(--ink);
  font-weight: 500;
}

.none {
  color: var(--ink-2);
}

.pending {
  color: var(--ink-2);
  font-style: italic;
}

.diffs {
  list-style: none;
  margin: 0;
  padding: 0;
}

.diffs li {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 14px;
  padding: 12px 0;
  border-bottom: 1px solid var(--track);
  overflow-wrap: anywhere;
}

/* On a phone the harness sits above its difference, so the long identifiers have the width. */
@media (max-width: 640px) {
  .diffs li {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}

.add-note {
  margin: 4px 0 14px;
}

.steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.steps li {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 10px;
}

.step-n {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1.5px solid var(--ink);
  font-size: 13px;
  font-weight: 600;
}

.cmd {
  font-size: 12px;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .diffs li {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>
