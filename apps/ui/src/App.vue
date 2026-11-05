<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import AppHeader from './components/AppHeader.vue';
import { currentHash, href, parseHash, sectionOf } from './router';
import BuildView from './views/BuildView.vue';
import CompareView from './views/CompareView.vue';
import ConfigPage from './views/ConfigPage.vue';
import ConfigView from './views/ConfigView.vue';
import ExperimentsView from './views/ExperimentsView.vue';
import HarnessesView from './views/HarnessesView.vue';
import JudgeView from './views/JudgeView.vue';
import LabelView from './views/LabelView.vue';
import OpenExampleView from './views/OpenExampleView.vue';
import RunView from './views/RunView.vue';
import StartView from './views/StartView.vue';
import TasksView from './views/TasksView.vue';
import TrialsView from './views/TrialsView.vue';
import TrialView from './views/TrialView.vue';

const route = computed(() => parseHash(currentHash.value));
const section = computed(() => sectionOf(route.value));

const onHash = () => {
  currentHash.value = window.location.hash;
};

/** The skip link cannot use #main: the hash is the route. */
function skipToContent() {
  document.getElementById('main')?.focus();
}

onMounted(() => window.addEventListener('hashchange', onHash));
onBeforeUnmount(() => window.removeEventListener('hashchange', onHash));

// A new screen starts at the top, and focus moves to its main heading for screen readers.
watch(
  () => currentHash.value.split('?')[0],
  async () => {
    window.scrollTo?.(0, 0);
    await nextTick();
    document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true });
  },
);
</script>

<template>
  <a
    class="skip"
    :href="currentHash || '#/'"
    @click.prevent="skipToContent"
  >Skip to content</a>
  <AppHeader :section="section" />
  <main
    id="main"
    class="page-main"
    tabindex="-1"
  >
    <StartView v-if="route.name === 'start'" />
    <BuildView v-else-if="route.name === 'build'" />
    <OpenExampleView v-else-if="route.name === 'example'" />
    <ExperimentsView v-else-if="route.name === 'experiments'" />
    <ConfigView
      v-else-if="route.name === 'config'"
      :key="`config-${route.fork}`"
      :fork="route.fork"
    />
    <ConfigPage
      v-else-if="route.name === 'config-page'"
      :key="`config-page-${route.hash}`"
      :config-hash="route.hash"
    />
    <RunView
      v-else-if="route.name === 'run-new'"
      :key="`new-${route.a}-${route.b}-${route.calibration}`"
      :a="route.a"
      :b="route.b"
      :calibration="route.calibration"
    />
    <RunView
      v-else-if="route.name === 'run'"
      :key="`run-${route.id}`"
      :experiment-id="route.id"
    />
    <CompareView
      v-else-if="route.name === 'compare'"
      :key="`compare-${route.id}`"
      :experiment-id="route.id"
      :panel="route.panel"
    />
    <TrialView
      v-else-if="route.name === 'trial'"
      :key="`trial-${route.id}`"
      :trial-id="route.id"
    />
    <TrialsView v-else-if="route.name === 'recorded'" />
    <LabelView
      v-else-if="route.name === 'labels'"
      :key="`labels-${route.set}-${route.experiment}-${route.items}`"
      :initial-set="route.set"
      :experiment="route.experiment"
      :items="route.items"
    />
    <JudgeView v-else-if="route.name === 'judge'" />
    <HarnessesView v-else-if="route.name === 'harnesses'" />
    <TasksView v-else-if="route.name === 'tasks'" />
    <div
      v-else
      class="page-head"
    >
      <h1 tabindex="-1">
        Page not found
      </h1>
      <p class="lede">
        Nothing lives at {{ route.path }}. <a :href="href.experiments()">Go to the experiments</a>
      </p>
    </div>
  </main>
</template>

<style scoped>
.skip {
  position: absolute;
  left: 8px;
  top: -60px;
  padding: 10px 14px;
  background: var(--primary);
  color: var(--on-primary);
  border-radius: 8px;
  z-index: 20;
}

.skip:focus {
  top: 8px;
}

main:focus {
  outline: none;
}
</style>
