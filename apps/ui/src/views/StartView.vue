<script setup lang="ts">
/**
 * The front door: three ways in (a finished example, the guided builder, the full platform) and
 * the five steps a reviewer follows, each linking to its screen. It only reads: the newest saved
 * agent, so "Preview what reaches the model" can open a real one.
 */
import { computed } from 'vue';
import { api } from '../api/client';
import type { ConfigView } from '../api/types';
import { optional, useLoad } from '../lib/async';
import { EXAMPLE_EXPERIMENT_ID, exampleHref } from '../lib/example';
import { href } from '../router';

/** The finished example's experiment id; null until it ships (lib/example.ts). */
const props = withDefaults(defineProps<{ exampleExperimentId?: string | null }>(), { exampleExperimentId: EXAMPLE_EXPERIMENT_ID });

const { data } = useLoad(() => optional(api.configs(), [] as ConfigView[]));
const newest = computed(() => [...(data.value ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null);
const example = computed(() => exampleHref(props.exampleExperimentId));
const exampleReady = computed(() => !!props.exampleExperimentId);

const doors = computed(() => [
  {
    key: 'example',
    title: 'See a finished example',
    detail: exampleReady.value
      ? 'A real A/B experiment, already run: its comparison, a trial’s trace and the grades.'
      : 'A real A/B experiment, already run. Until it ships, this opens the experiments list.',
    to: example.value,
  },
  {
    key: 'build',
    title: 'Build your own, step by step',
    detail: 'Pick an agent type, a model, its instructions and settings on one page, then evaluate it.',
    to: href.build(),
  },
  {
    key: 'full',
    title: 'Go straight to the full platform',
    detail: 'Every experiment, config, task, harness and label, at full detail.',
    to: href.experiments(),
  },
]);

const steps = computed(() => [
  {
    key: 'example',
    title: 'Look at the finished example',
    detail: 'Open its comparison: the verdict with its interval and the per-task differences. Then open one trial for its trace, step by step, and its grades.',
    link: exampleReady.value ? 'Open the example' : 'Open the experiments',
    to: example.value,
  },
  {
    key: 'build',
    title: 'Build your own',
    detail: 'Agent type, model, prompt and settings, each with an i that says what it does.',
    link: 'Build an agent',
    to: href.build(),
  },
  {
    key: 'preview',
    title: 'Preview what reaches the model',
    detail: 'On the agent’s page: a free preview of exactly what the model receives, the harness’s own text with your prompt marked inside it.',
    link: newest.value ? `Open the newest agent, ${newest.value.name}` : 'Build an agent first',
    to: newest.value ? href.configPage(newest.value.hash) : href.build(),
  },
  {
    key: 'evaluate',
    title: 'Evaluate it against a baseline',
    detail: 'On the Run screen, arm A is the baseline and arm B your agent. It shows the trials, models and cost before anything starts.',
    link: 'Set up a run',
    to: href.runNew(),
  },
  {
    key: 'result',
    title: 'Read the result',
    detail: 'Better, worse or no clear difference, with how sure we can be, then the tasks and trials behind it.',
    link: 'Open the experiments',
    to: href.experiments(),
  },
]);
</script>

<template>
  <div class="page-head">
    <h1 tabindex="-1">
      Evaluate an agent
    </h1>
    <p class="lede">
      Run two versions of an agent on the same tasks and see whether the change made it better, worse or no different, and how sure we can be.
    </p>
  </div>

  <section
    aria-labelledby="ways-in"
    class="stack"
  >
    <h2
      id="ways-in"
      class="visually-hidden"
    >
      Three ways in
    </h2>
    <ul class="doors">
      <li
        v-for="d in doors"
        :key="d.key"
      >
        <a
          :href="d.to"
          class="door"
          :data-test="`door-${d.key}`"
        >
          <span class="door-title">{{ d.title }}</span>
          <span class="secondary small">{{ d.detail }}</span>
        </a>
      </li>
    </ul>
  </section>

  <section
    aria-labelledby="how-to"
    class="panel panel--pad guide"
    data-test="guide"
  >
    <h2
      id="how-to"
      class="section-title"
    >
      How to use this
    </h2>
    <ol class="steps">
      <li
        v-for="(s, i) in steps"
        :key="s.key"
        :data-test="`guide-${s.key}`"
      >
        <span
          class="step-n"
          aria-hidden="true"
        >{{ i + 1 }}</span>
        <span>
          <span class="step-title">{{ s.title }}</span>
          <span class="secondary small block">{{ s.detail }}</span>
          <a
            :href="s.to"
            class="small step-link"
          >{{ s.link }}</a>
        </span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.doors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
}

.door {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 44px;
  padding: 20px 22px;
  border-radius: 12px;
  border: 1px solid var(--rule);
  background: var(--surface);
  color: var(--ink);
  text-decoration: none;
}

.door:hover {
  color: var(--ink);
  border-color: var(--rule-strong);
}

.door:hover .door-title {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.door-title {
  font-size: 18px;
  font-weight: 600;
}

.guide {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 820px;
}

.steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.steps li {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 12px;
}

/* As on the Harnesses page's "Add a harness" steps. */
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

.step-title {
  display: block;
  font-weight: 600;
}

.block {
  display: block;
}

.step-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-weight: 500;
}

@media (max-width: 640px) {
  .door {
    padding: 18px;
  }
}
</style>
