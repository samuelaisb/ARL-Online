import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const apiTarget = process.env.VITE_API_TARGET || `http://localhost:${process.env.PORT || 3000}`;

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': apiTarget,
      '/assets/inventory': apiTarget,
      '/assets/fonts': apiTarget,
      '/assets/brand': apiTarget,
    },
  },
});
