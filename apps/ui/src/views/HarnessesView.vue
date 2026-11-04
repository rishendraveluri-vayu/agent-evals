<script setup lang="ts">
import { computed } from 'vue';
import { api } from '../api/client';
import { SETTING_NAMES, type Harness } from '../api/types';
import LoadState from '../components/LoadState.vue';
import { useLoad } from '../lib/async';
import { matrixCell } from '../lib/capabilities';
import { shortRef } from '../lib/format';
import { harnessName, harnessShort, settingLabel } from '../lib/names';

const { data, error, loading } = useLoad(() => api.harnesses());

function checked(h: Harness) {
  const all = Object.values(h.capabilities.settings);
  const done = all.filter((s) => s.evidence !== 'none').length;
  return { done, total: all.length, complete: done === all.length };
}

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
            <span><span class="probed">Probed</span>: seen in a request</span>
            <span><span class="declared">Declared</span>: a request cannot show it</span>
            <span><span class="none">Not supported</span>: the harness has no such feature</span>
          </div>
        </div>
        <div class="table-wrap">
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
                    class="pill pill--small status"
                    :class="checked(h).complete ? 'pill--pass' : 'pill--dashed'"
                  >{{ checked(h).done }} of {{ checked(h).total }} checked</span>
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
                  <span :class="matrixCell(h.capabilities.settings[name]).kind">{{ matrixCell(h.capabilities.settings[name]).text }}</span>
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
              <span>{{ d.text }}</span>
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

.matrix {
  min-width: 1040px;
  table-layout: fixed;
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

.status {
  margin-top: 6px;
}

.block {
  display: block;
}

.strong {
  font-weight: 500;
}

.probed {
  color: var(--pass);
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
  grid-template-columns: 150px 1fr;
  gap: 14px;
  padding: 12px 0;
  border-bottom: 1px solid var(--track);
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
