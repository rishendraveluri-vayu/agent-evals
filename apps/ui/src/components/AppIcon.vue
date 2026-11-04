<script setup lang="ts">
/** Inline stroke icons in the text colour, always next to a word, never instead of one. */
export type IconName =
  | 'plus'
  | 'check'
  | 'cross'
  | 'plug'
  | 'alert'
  | 'info'
  | 'eye-off'
  | 'tool'
  | 'sun'
  | 'moon'
  | 'pass-badge'
  | 'fail-badge'
  | 'infra-badge'
  | 'arrow-up'
  | 'arrow-down'
  | 'tag';

withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 20 });
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 20 20"
    aria-hidden="true"
    focusable="false"
    class="icon"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path
      v-if="name === 'plus'"
      d="M10 4v12M4 10h12"
      stroke-width="2"
    />
    <path
      v-else-if="name === 'check'"
      d="M4 10.5l4 4 8-9"
    />
    <path
      v-else-if="name === 'cross'"
      d="M5.5 5.5l9 9M14.5 5.5l-9 9"
      stroke-width="2"
    />
    <path
      v-else-if="name === 'plug'"
      d="M7 2v4M13 2v4M5 6h10v3a5 5 0 0 1-10 0V6zM10 14v4"
    />
    <g v-else-if="name === 'alert'">
      <circle
        cx="10"
        cy="10"
        r="7"
      />
      <path d="M10 6v5M10 13.5v.5" />
    </g>
    <g v-else-if="name === 'info'">
      <circle
        cx="10"
        cy="10"
        r="7"
      />
      <path d="M10 9v4.5M10 6.5v.5" />
    </g>
    <g v-else-if="name === 'eye-off'">
      <path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z" />
      <circle
        cx="10"
        cy="10"
        r="2.2"
      />
      <path d="M3 17L17 3" />
    </g>
    <path
      v-else-if="name === 'tool'"
      d="M13 3a3.6 3.6 0 0 0-4.7 4.7L3 13l3.7 3.7L12 11.4A3.6 3.6 0 0 0 16.7 6.7l-2.4 2.4-2.6-.8-.8-2.6L13 3z"
    />
    <g v-else-if="name === 'sun'">
      <circle
        cx="10"
        cy="10"
        r="3.5"
      />
      <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" />
    </g>
    <path
      v-else-if="name === 'moon'"
      d="M16 12.5A6.5 6.5 0 0 1 7.5 4a6.5 6.5 0 1 0 8.5 8.5z"
    />
    <g v-else-if="name === 'pass-badge'">
      <circle
        cx="10"
        cy="10"
        r="8.5"
        class="badge-fill badge-fill--pass"
        stroke="none"
      />
      <path
        d="M6 10.3l2.6 2.6L14 7.5"
        class="badge-mark--pass"
        stroke-width="1.9"
      />
    </g>
    <g v-else-if="name === 'fail-badge'">
      <circle
        cx="10"
        cy="10"
        r="8.5"
        class="badge-fill badge-fill--fail"
        stroke="none"
      />
      <path
        d="M7 7l6 6M13 7l-6 6"
        class="badge-mark--fail"
        stroke-width="1.9"
      />
    </g>
    <path
      v-else-if="name === 'arrow-up'"
      d="M10 16V4M5 9l5-5 5 5"
      stroke-width="2"
    />
    <path
      v-else-if="name === 'arrow-down'"
      d="M10 4v12M5 11l5 5 5-5"
      stroke-width="2"
    />
    <g v-else-if="name === 'tag'">
      <path d="M3 3.5v6l7.5 7.5 6-6L9 3.5H3z" />
      <circle
        cx="6.5"
        cy="7"
        r="1.2"
      />
    </g>
    <g v-else-if="name === 'infra-badge'">
      <circle
        cx="10"
        cy="10"
        r="8"
        stroke-dasharray="3 2"
        stroke-width="1.4"
      />
      <path d="M10 6v5M10 13.5v.5" />
    </g>
  </svg>
</template>

<style scoped>
.icon {
  flex: none;
}

.badge-fill--pass {
  fill: var(--pass-soft);
}

.badge-fill--fail {
  fill: var(--fail-soft);
}

.badge-mark--pass {
  stroke: var(--pass);
}

.badge-mark--fail {
  stroke: var(--fail);
}
</style>
