import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import StackBlitz from './StackBlitz.vue'

// Extends the default VitePress theme with a global <StackBlitz> button used
// across the guide and cookbook to launch runnable examples in the browser.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('StackBlitz', StackBlitz)
  },
} satisfies Theme
