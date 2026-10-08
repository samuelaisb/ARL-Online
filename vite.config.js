import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const apiTarget = process.env.VITE_API_TARGET || `http://localhost:${process.env.PORT || 3000}`;

export default defineConfig({
  envPrefix: ['VITE_', 'SITE_'],
  plugins: [svelte()],
  // No manualChunks: named chunks pulled shared deps (Svelte runtime, supabase-js)
  // into page chunks and made the entry import them statically, which defeated
  // App.svelte's lazy pages (dynamic imports behind `lazyPage(load…)`).
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': apiTarget,
      '/config.js': apiTarget,
      '/assets/inventory': apiTarget,
      '/assets/fonts': apiTarget,
      '/assets/brand': apiTarget,
      '/media': apiTarget,
      '/robots.txt': apiTarget,
      '/sitemap.xml': apiTarget,
    },
  },
});
