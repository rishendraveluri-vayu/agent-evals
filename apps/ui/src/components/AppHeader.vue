<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api/client';
import { isFixtureMode } from '../api/mode';
import { fetchHealth, type HealthResult } from '../health';
import { money, wholeMoney } from '../lib/format';
import { setTheme, theme } from '../lib/theme';
import { href, type Section } from '../router';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ section: Section | null }>();

const fixtures = isFixtureMode();
const health = ref<HealthResult | null>(null);
const spend = ref<number | null>(null);
const budget = ref<number | null>(null);

const links: { section: Section; label: string; to: string }[] = [
  { section: 'experiments', label: 'Experiments', to: href.experiments() },
  { section: 'configs', label: 'Configs', to: href.config() },
  { section: 'tasks', label: 'Tasks', to: href.tasks() },
  { section: 'harnesses', label: 'Harnesses', to: href.harnesses() },
  { section: 'labels', label: 'Labels', to: href.labels() },
];

const dbWords: Record<string, string> = { up: 'up', down: 'down', not_configured: 'not configured' };
const spentShare = computed(() => (spend.value !== null && budget.value ? Math.min(100, (spend.value / budget.value) * 100) : 0));
const dark = computed(() => theme.value === 'dark');
const spendWords = computed(() => (spend.value === null ? '' : `${money(spend.value)} spent${budget.value ? ` of ${wholeMoney(budget.value)}` : ''}`));
/** "$54 of $150": whole dollars for the phone header, where there is no room for cents. */
const compactSpend = computed(() => (spend.value === null ? '' : `$${Math.round(spend.value)}${budget.value ? ` of ${wholeMoney(budget.value)}` : ''}`));

/** On a phone the nav is one row that scrolls sideways; the current section is kept in view, with
 *  8 px to spare past its right edge. Only the nav scrolls (never scrollIntoView, which can move
 *  the page). It runs again once the fonts are in and whenever the nav changes size, since both
 *  move the tabs. */
const nav = ref<HTMLElement | null>(null);
const EDGE = 8;
async function showCurrent() {
  await nextTick();
  const el = nav.value;
  const current = el?.querySelector<HTMLElement>('[aria-current="page"]');
  if (!el || !current || el.scrollWidth <= el.clientWidth) return;
  const box = el.getBoundingClientRect();
  const tab = current.getBoundingClientRect();
  const past = tab.right + EDGE - box.right;
  const before = box.left - (tab.left - EDGE);
  if (past > 0) el.scrollLeft += past;
  else if (before > 0) el.scrollLeft -= before;
}
watch(
  () => props.section,
  () => void showCurrent(),
);

let resizes: ResizeObserver | null = null;
onBeforeUnmount(() => resizes?.disconnect());

onMounted(async () => {
  void showCurrent();
  void document.fonts?.ready.then(() => showCurrent());
  if (typeof ResizeObserver !== 'undefined' && nav.value) {
    resizes = new ResizeObserver(() => void showCurrent());
    resizes.observe(nav.value);
  }
  const envBudget = Number(import.meta.env.VITE_TOTAL_BUDGET_USD);
  if (fixtures) {
    const { meta } = await import('../fixtures');
    budget.value = meta.total_budget_usd;
  } else {
    if (Number.isFinite(envBudget) && envBudget > 0) budget.value = envBudget;
    void fetchHealth().then((h) => (health.value = h));
  }
  try {
    const experiments = await api.experiments();
    spend.value = experiments.reduce((sum, e) => sum + (e.spend_usd ?? 0), 0);
  } catch {
    spend.value = null;
  }
});
</script>

<template>
  <header class="top">
    <a
      :href="href.experiments()"
      class="brand"
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          d="M3 12h18M3 8v8M21 8v8"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          fill="none"
        />
        <circle
          cx="14"
          cy="12"
          r="4"
          class="brand-dot"
        />
      </svg>
      Agent Evals
    </a>
    <nav
      ref="nav"
      aria-label="Main"
      class="nav"
    >
      <a
        v-for="l in links"
        :key="l.section"
        :href="l.to"
        :aria-current="section === l.section ? 'page' : undefined"
      >{{ l.label }}</a>
    </nav>
    <div class="right">
      <span
        v-if="spend !== null"
        class="spend"
        data-test="spend"
      >
        <span class="wide-only">Spend</span>
        <span
          v-if="budget"
          class="meter spend-meter wide-only"
          role="img"
          :aria-label="spendWords"
        ><span :style="{ width: `${spentShare}%` }" /></span>
        <span class="num ink wide-only">{{ money(spend) }}<template v-if="budget"> of {{ wholeMoney(budget) }}</template></span>
        <span
          class="num ink phone-only"
          role="img"
          :aria-label="spendWords"
          data-test="spend-compact"
        >{{ compactSpend }}</span>
      </span>
      <span
        v-if="fixtures"
        class="pill pill--outline pill--small sample"
        data-test="sample-data"
      >Sample data</span>
      <template v-else>
        <span
          v-if="health === null"
          class="health"
          role="status"
          data-test="health-loading"
        >Checking the API</span>
        <span
          v-else-if="health.kind === 'unreachable'"
          class="health health--down"
          role="alert"
          data-test="health-unreachable"
        ><AppIcon
          name="alert"
          :size="16"
        />API unreachable ({{ health.reason }})</span>
        <span
          v-else
          class="health"
          data-test="health-ok"
        >API <span data-test="health-status">{{ health.health.status }}</span>, database
          <span
            data-test="health-db"
            :class="{ 'health--down': health.health.db === 'down' }"
          >{{ dbWords[health.health.db] }}</span></span>
      </template>
      <button
        type="button"
        class="theme"
        aria-label="Dark theme"
        :aria-pressed="dark"
        data-test="theme-toggle"
        @click="setTheme(dark ? 'light' : 'dark')"
      >
        <AppIcon
          :name="dark ? 'sun' : 'moon'"
          :size="18"
        />
        <span class="theme-text">Dark theme</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 28px;
  padding: 6px 32px;
  background: var(--surface);
  border-bottom: 1px solid var(--rule);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  text-decoration: none;
  color: var(--ink);
  font-weight: 600;
  font-size: 16px;
}

.brand:hover {
  color: var(--ink);
}

.brand-dot {
  fill: currentColor;
}

.nav {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.nav a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 6px;
  text-decoration: none;
  color: var(--ink-2);
}

.nav a:hover {
  color: var(--ink);
  background: var(--surface-muted);
}

.nav a[aria-current='page'] {
  color: var(--ink);
  background: var(--surface-muted);
  font-weight: 600;
}

.right {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  color: var(--ink-2);
  font-size: 14px;
}

.spend {
  display: flex;
  align-items: center;
  gap: 10px;
}

.spend-meter {
  width: 96px;
}

.ink {
  color: var(--ink);
}

.sample {
  border-color: var(--rule-strong);
  color: var(--ink-2);
}

.phone-only {
  display: none;
}

.health {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.health--down {
  color: var(--error);
}

.theme {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--rule);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
}

.theme[aria-pressed='true'] {
  background: var(--surface-muted);
}

/* A phone gets two rows: the brand, the spend, the sample flag and the theme button, then the
   sections in one row that scrolls sideways. */
@media (max-width: 640px) {
  .top {
    padding: 0 12px 2px;
    gap: 0 8px;
  }

  .brand {
    gap: 8px;
    font-size: 15px;
  }

  .right {
    flex-wrap: nowrap;
    gap: 6px;
    font-size: 13px;
  }

  .wide-only {
    display: none;
  }

  .phone-only {
    display: inline;
  }

  .theme {
    justify-content: center;
    width: 44px;
    padding: 0;
  }

  .theme-text {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .nav {
    order: 3;
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    width: calc(100% + 24px);
    margin: 0 -12px;
    padding: 0 8px;
  }

  .nav a {
    flex: none;
    padding: 0 10px;
    white-space: nowrap;
  }
}
</style>
