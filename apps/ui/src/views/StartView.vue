<script setup lang="ts">
/**
 * The front door: three ways in (a finished example, the guided builder, the full platform) and
 * the five steps a reviewer follows, each linking to its screen. It only reads: the newest saved
 * agent, so "Preview what reaches the model" can open a real one, and the shipped example's title,
 * so the card names the run it opens. The example opens through #/example, which loads the
 * shipped example the first time.
 *
 * Every line says only what this version does: it reports pass counts, cost and time per version
 * and per task; the verdict with its interval (the statistics step) is not built yet.
 */
import { computed } from 'vue';
import { api } from '../api/client';
import { isFixtureMode } from '../api/mode';
import type { ConfigView, ExampleView } from '../api/types';
import { optional, useLoad } from '../lib/async';
import { href } from '../router';

const { data } = useLoad(async () => {
  const [configs, examples] = await Promise.all([optional(api.configs(), [] as ConfigView[]), optional(api.examples(), [] as ExampleView[])]);
  return { configs, example: examples[0] ?? null };
});
const newest = computed(() => [...(data.value?.configs ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null);

/** The example's own title, as its comparison page shows it, and whether it is the small draft
 *  that stands in until the full experiment is exported (its manifest's title says so). */
const example = computed(() => {
  const e = data.value?.example;
  if (!e) return null;
  return { title: e.title, draft: /^draft\b/i.test(e.title) };
});

const doors = computed(() => [
  {
    key: 'example',
    title: 'See a finished example',
    name: example.value?.title ?? null,
    detail: `${isFixtureMode() ? 'Sample data standing in for the real run the repo ships' : 'A real run on a real model, shipped with the repo'} and opened read-only: how each version did per task, every trial’s trace and its grades.${
      example.value?.draft ? ' It is a small draft, for now: the full experiment replaces it.' : ''
    } Nothing runs and nothing is spent.`,
    to: href.example(),
  },
  {
    key: 'build',
    title: 'Build your own, step by step',
    name: null,
    detail: 'Pick an agent type, a model, its instructions and settings on one page, then evaluate it.',
    to: href.build(),
  },
  {
    key: 'full',
    title: 'Go straight to the full platform',
    name: null,
    detail: 'Every experiment, config, task, harness and label, at full detail.',
    to: href.experiments(),
  },
]);

const steps = computed(() => [
  {
    key: 'example',
    title: 'Look at the finished example',
    detail: 'Open its comparison: how each version did on each task. Then open one trial for its trace, step by step, and its grades.',
    link: 'Open the example',
    to: href.example(),
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
    detail: 'Pass counts, cost and time for each version, then task by task down to each trial. This version gives counts only: the verdict with its interval, how sure a difference is, is not built yet.',
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
      Run two versions of an agent on the same tasks, then compare them task by task, down to each trial’s trace and grades. This version reports pass counts, cost and time; the verdict with its interval, whether a change is better or worse and how sure we can be, is not built yet.
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
          <span
            v-if="d.name"
            class="small door-name"
            data-test="door-example-name"
          >{{ d.name }}</span>
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

.door-name {
  font-weight: 500;
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
