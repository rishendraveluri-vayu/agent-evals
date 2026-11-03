// vue-tsc reads .vue files itself, but typescript-eslint's type-aware rules use
// plain TypeScript, which would type `import App from './App.vue'` as an error.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
