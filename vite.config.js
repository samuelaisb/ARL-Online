import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const apiTarget = process.env.VITE_API_TARGET || `http://localhost:${process.env.PORT || 3000}`;

export default defineConfig({
  envPrefix: ['VITE_', 'SITE_'],
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('AdminPage') || id.includes('AdminPanel')) {
            return 'admin';
          }

          if (id.includes('ItemCalendar') || id.includes('ItemDetailPage')) {
            return 'calendar';
          }

          if (id.includes('HowThisWorksPage')) {
            return 'how-this-works';
          }

          if (id.includes('AboutPage')) {
            return 'about';
          }
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': apiTarget,
      '/config.js': apiTarget,
      '/assets/inventory': apiTarget,
      '/assets/fonts': apiTarget,
      '/assets/brand': apiTarget,
      '/robots.txt': apiTarget,
      '/sitemap.xml': apiTarget,
    },
  },
});
