<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import SpanTimeline from '../components/SpanTimeline.vue';
import { fetchSpans, fetchTrial, fileUrl, text, usd, type SpanView, type TrialDetail } from '../trials';

const props = defineProps<{ trialId: string }>();
const detail = ref<TrialDetail | null>(null);
const spans = ref<SpanView[]>([]);
const error = ref<string | null>(null);
const selectedId = ref<string | null>(null);

onMounted(async () => {
  try {
    [detail.value, spans.value] = await Promise.all([fetchTrial(props.trialId), fetchSpans(props.trialId)]);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});

type Turn = { role: string; content: string; source?: string };
type Applied = Record<string, { value: unknown; source: string; observed?: string }>;
const result = computed<Record<string, unknown>>(() => detail.value?.result ?? {});
const transcript = computed(() => ((result.value.conversation as { transcript?: Turn[] })?.transcript ?? []));
const applied = computed(() => Object.entries((result.value.applied_settings ?? {}) as Applied));
const selected = computed(() => spans.value.find((s) => s.spanId === selectedId.value) ?? null);
const s = computed(() => detail.value?.summary);
const endDetail = computed(() => (result.value.end_detail ?? {}) as Record<string, unknown>);
const fmt = text;
const refs = (span: SpanView) =>
  (['evals.request_ref', 'evals.response_ref'] as const).filter((k) => typeof span.attributes[k] === 'string');
</script>

<template>
  <p><a href="#/trials">← All trials</a></p>
  <p
    v-if="error"
    role="alert"
  >
    Could not load trial {{ trialId }}: {{ error }}
  </p>
  <template v-else-if="detail && s">
    <section class="card">
      <h2>{{ s.trialId }}</h2>
      <dl class="facts">
        <dt>Harness</dt><dd>{{ s.harness }} {{ fmt((result.harness as Record<string, unknown>)?.version) }}</dd>
        <dt>Model</dt><dd>{{ s.model }}</dd>
        <dt>Task</dt><dd>{{ s.taskId }}</dd>
        <dt>Prompt / toolset</dt><dd>{{ s.promptVersion }} / {{ s.toolsetVersion }}</dd>
        <dt>End state</dt><dd><span class="tag">{{ s.endState }}</span> {{ fmt(endDetail.harness_stop_reason) }}</dd>
        <dt>Label</dt><dd><span class="tag">{{ s.label }}</span></dd>
        <dt>Model calls</dt><dd>{{ s.proxyCalls ?? '–' }} logged by LiteLLM, {{ s.harnessCalls ?? '–' }} counted by the harness</dd>
        <dt>Cost</dt><dd>{{ usd(s.proxyCostUsd) }} ({{ s.proxyInputTokens ?? '–' }} in / {{ s.proxyOutputTokens ?? '–' }} out tokens)</dd>
        <dt>Tools</dt><dd>{{ s.toolCalls }} calls, {{ s.toolErrors }} errors, {{ s.malformedToolCalls }} malformed</dd>
        <dt>Wall time</dt><dd>{{ s.wallS?.toFixed(2) }} s</dd>
        <dt v-if="endDetail.exception_type">
          Exception
        </dt>
        <dd v-if="endDetail.exception_type">
          {{ fmt(endDetail.exception_type) }}: {{ fmt(endDetail.exception_message) }}
        </dd>
      </dl>
    </section>

    <section class="card">
      <h2>Timeline</h2>
      <SpanTimeline
        :spans="spans"
        :selected="selectedId"
        @select="selectedId = $event"
      />
      <div
        v-if="selected"
        class="span-detail"
        data-test="span-detail"
      >
        <h3>{{ selected.name }}</h3>
        <p
          v-if="selected.statusMessage"
          class="muted"
        >
          {{ selected.statusMessage }}
        </p>
        <p v-if="refs(selected).length">
          <a
            v-for="k in refs(selected)"
            :key="k"
            :href="fileUrl(trialId, text(selected.attributes[k]))"
            target="_blank"
            rel="noopener"
          >{{ k === 'evals.request_ref' ? 'Request body' : 'Response body' }}</a>
        </p>
        <table class="data">
          <tbody>
            <tr
              v-for="(v, k) in selected.attributes"
              :key="k"
            >
              <th>{{ k }}</th>
              <td class="value-cell">
                {{ fmt(v) }}
              </td>
            </tr>
          </tbody>
        </table>
        <template v-if="selected.events.length">
          <h3>Events</h3>
          <table class="data">
            <tbody>
              <tr
                v-for="(e, i) in selected.events"
                :key="i"
              >
                <th>{{ e.name }}</th>
                <td class="value-cell">
                  {{ fmt(e.attributes) }}
                </td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
      <p
        v-else
        class="muted"
      >
        Select a span to see its attributes.
      </p>
    </section>

    <section class="card">
      <h2>Conversation</h2>
      <ol class="transcript">
        <li
          v-for="(t, i) in transcript"
          :key="i"
          :class="`turn turn--${t.role}`"
        >
          <span class="who">{{ t.source === 'client_sim' ? 'client (simulated)' : t.role === 'user' ? 'client' : 'agent' }}</span>
          <span class="text">{{ t.content }}</span>
        </li>
      </ol>
    </section>

    <section class="card">
      <h2>Applied settings</h2>
      <table class="data">
        <thead>
          <tr>
            <th>Setting</th><th>Value</th><th>Source</th><th>Observed</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="[name, a] in applied"
            :key="name"
          >
            <td>{{ name }}</td>
            <td>{{ fmt(a.value) }}</td>
            <td><span class="tag">{{ a.source }}</span></td>
            <td class="muted">
              {{ a.observed ?? '' }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </template>
  <p
    v-else
    class="muted"
    role="status"
  >
    Loading trial…
  </p>
</template>

<style scoped>
.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 1rem;
  margin: 0;
  font-size: 0.9rem;
}

.facts dt {
  font-weight: 600;
  color: var(--text-secondary);
}

.facts dd {
  margin: 0;
}

.span-detail h3 {
  font-size: 0.95rem;
  margin: 1rem 0 0.25rem;
}

.value-cell {
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 48rem;
}

.transcript {
  list-style: none;
  padding: 0;
  margin: 0;
}

.turn {
  display: grid;
  grid-template-columns: 9rem 1fr;
  gap: 0.75rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--grid);
}

.who {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.text {
  white-space: pre-wrap;
}
</style>
