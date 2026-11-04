<script setup lang="ts">
/** A screen whose address names something that does not exist (a mistyped or stale link, or one
 *  from another database): a breadcrumb back, what was asked for, and where to go instead (the
 *  slot), as the run page's "Not found" screen has. */
defineProps<{
  /** The way back, outermost first: "Experiments". */
  crumbs: { href: string; text: string }[];
  /** "No experiment with that id" */
  title: string;
  /** The id the address asked for. */
  itemId: string;
}>();
</script>

<template>
  <div
    class="page-head"
    data-test="not-found"
  >
    <nav
      aria-label="Breadcrumb"
      class="crumbs"
    >
      <template
        v-for="c in crumbs"
        :key="c.href"
      >
        <a :href="c.href">{{ c.text }}</a> /
      </template>Not found
    </nav>
    <h1 tabindex="-1">
      {{ title }}
    </h1>
    <p class="lede">
      Nothing is saved as <span class="mono">{{ itemId }}</span>: the link may be mistyped, or from another database.
      <slot />
    </p>
  </div>
</template>
