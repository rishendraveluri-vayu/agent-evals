<script setup lang="ts">
/**
 * #/example: the front door's "See a finished example". It asks the API which examples ship with
 * the repo (sorted by name), copies the first one and its companions into this database if they are
 * missing (insert-only; nothing runs and nothing is spent; a second load changes nothing), opens the
 * first one's comparison, and copies the rest in the background. A companion is an example whose
 * name starts with the first one's name: the headline's A/A calibration, whose line its comparison
 * shows. The address is replaced, not kept, so Back from the comparison returns to the front door.
 */
import { onMounted, ref } from 'vue';
import { api } from '../api/client';
import { ApiError, errorFix, errorText } from '../api/errors';
import type { ExampleView } from '../api/types';
import { plainText } from '../lib/format';
import { href, replaceRoute } from '../router';

const status = ref<'finding' | 'loading' | 'none' | 'failed'>('finding');
const example = ref<ExampleView | null>(null);
const problem = ref<{ text: string; fix: string | null } | null>(null);

/** Copies one example. The machine it was exported from already holds the same run as its own: the
 *  load is refused (409), and that run is the example, so it counts as loaded. */
async function load(ex: ExampleView): Promise<void> {
  try {
    await api.loadExample(ex.name);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'example_conflict' && (await hasExperiment(ex.experiment_id)))) throw err;
  }
}

async function hasExperiment(id: string): Promise<boolean> {
  try {
    await api.experiment(id);
    return true;
  } catch {
    return false;
  }
}

onMounted(async () => {
  try {
    const list = await api.examples();
    const first = list[0] ?? null;
    example.value = first;
    if (!first) {
      status.value = 'none';
      return;
    }
    // The first example and its companions load before its comparison opens: the headline shows its
    // A/A calibration only when the calibration run is in the database too. Loads only insert, so
    // an example already here is skipped.
    const needed = list.filter((ex) => ex.name === first.name || ex.name.startsWith(`${first.name}-`));
    for (const ex of needed) {
      if (ex.loaded) continue;
      status.value = 'loading';
      example.value = ex;
      await load(ex);
    }
    replaceRoute(href.compare(first.experiment_id));
    // The other examples (the controls and the replications) are copied after the comparison
    // opens, one at a time, so the first open stays quick; they appear in the experiments list as
    // each lands. A failure here is not the reader's problem: the next visit tries again.
    void (async () => {
      for (const ex of list) {
        if (ex.loaded || needed.includes(ex)) continue;
        try {
          await load(ex);
        } catch {
          return;
        }
      }
    })();
  } catch (err) {
    status.value = 'failed';
    const fix = errorFix(err);
    problem.value = { text: plainText(errorText(err)), fix: fix ? plainText(fix) : null };
  }
});
</script>

<template>
  <div class="page-head">
    <h1 tabindex="-1">
      The finished example
    </h1>
    <p
      v-if="status === 'finding' || status === 'loading'"
      class="lede"
      role="status"
      data-test="example-status"
    >
      <template v-if="status === 'finding'">
        Finding the example shipped with this copy.
      </template>
      <template v-else>
        Copying <strong>{{ example?.title }}</strong> into your local database, the first time only. Nothing runs and nothing is spent.
      </template>
    </p>
  </div>

  <div
    v-if="status === 'none'"
    class="panel panel--pad stack"
    data-test="example-none"
  >
    <p>This copy of the platform ships no finished example (the repo's <span class="mono">examples/</span> folder is empty or not mounted).</p>
    <p class="small">
      <a :href="href.experiments()">Open the experiments</a> or <a :href="href.build()">build your own agent</a>.
    </p>
  </div>

  <div
    v-else-if="status === 'failed'"
    class="panel panel--pad stack"
    role="alert"
    data-test="example-failed"
  >
    <p>The example could not be opened: {{ problem?.text }}</p>
    <p
      v-if="problem?.fix"
      class="small"
    >
      {{ problem.fix }}
    </p>
    <p class="small">
      <a :href="href.experiments()">Open the experiments</a> or <a :href="href.start()">go back</a>.
    </p>
  </div>
</template>
