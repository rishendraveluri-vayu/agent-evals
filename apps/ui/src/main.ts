import { createApp } from 'vue';
// IBM Plex Sans by unicode-range, so a page fetches only the subsets its text uses (fonts.css).
import './fonts.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import App from './App.vue';
import { applyTheme, followSystem } from './lib/theme';
import './theme.css';

applyTheme();
followSystem();
createApp(App).mount('#app');
