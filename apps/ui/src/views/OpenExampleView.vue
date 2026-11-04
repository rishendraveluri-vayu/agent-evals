<script setup lang="ts">
/**
 * #/example: the front door's "See a finished example". It asks the API which examples ship with
 * the repo, copies the first one into this database if it is not there yet (insert-only; nothing
 * runs and nothing is spent; a second load changes nothing), then opens its comparison. The
 * address is replaced, not kept, so Back from the comparison returns to the front door.
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
    if (!first.loaded) {
      status.value = 'loading';
      try {
        await api.loadExample(first.name);
      } catch (err) {
        // The machine the example was exported from already holds the same run as its own: the
        // load is refused (409), and that run is the example, so open it.
        if (!(err instanceof ApiError && err.code === 'example_conflict' && (await hasExperiment(first.experiment_id)))) throw err;
      }
    }
    replaceRoute(href.compare(first.experiment_id));
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
