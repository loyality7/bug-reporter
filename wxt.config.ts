import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Session Bug Reporter',
    description: 'Offline, session-based bug capture. Everything stays local.',
    // The overlay mounts these as iframes inside the page, so they must be page-loadable.
    web_accessible_resources: [
      { resources: ['quick.html', 'editor.html'], matches: ['<all_urls>'] },
    ],
    permissions: ['storage', 'tabs', 'activeTab', 'scripting', 'unlimitedStorage'],
    host_permissions: ['<all_urls>', 'https://api.github.com/*', 'https://github.com/*'],
    // One shortcut only, repeating whatever capture style was last used. Ctrl+Shift+K is
    // unbound in Chromium on both platforms — B toggles the bookmarks bar, and V/F/D/S are
    // all taken. Rebindable at chrome://extensions/shortcuts.
    commands: {
      'capture-bug': {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Capture a bug',
      },
    },
  },
});
