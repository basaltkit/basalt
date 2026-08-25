<script setup lang="ts">
// Opens a repo in a StackBlitz WebContainer. Defaults to the standalone,
// PUBLIC basalt-playground repo (published @basaltkit/* deps, no workspace
// protocol) so readers can boot a real Basalt server in the browser — the main
// monorepo is private and its apps use workspace: deps, so it can't be opened.
const props = withDefaults(
  defineProps<{ repo?: string; path?: string; file?: string; label?: string }>(),
  { repo: 'basaltkit/basalt-playground', path: '', label: 'Open in StackBlitz' },
)
const href = () => {
  const base = `https://stackblitz.com/github/${props.repo}${props.path ? `/tree/main/${props.path}` : ''}`
  return props.file ? `${base}?file=${encodeURIComponent(props.file)}` : base
}
</script>

<template>
  <a class="sb-btn" :href="href()" target="_blank" rel="noreferrer">
    <span class="sb-bolt">⚡</span>{{ label }}
  </a>
</template>

<style scoped>
.sb-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  padding: 0.5em 0.95em;
  border-radius: 8px;
  background: var(--vp-c-brand-1);
  color: var(--vp-c-white);
  font-weight: 600;
  font-size: 0.9em;
  text-decoration: none;
  transition: background 0.2s;
}
.sb-btn:hover { background: var(--vp-c-brand-2); }
.sb-bolt { font-size: 1.05em; }
</style>
