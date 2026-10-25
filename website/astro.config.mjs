import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  site: 'https://taco3064.github.io', base: '/nibfin/', trailingSlash: 'always',
  integrations: [react(), starlight({
    title: 'Nibfin', components: { Head: './src/components/Head.astro' }, locales: { root: { label: 'English', lang: 'en' } },
    customCss: ['./src/styles/theme.css'],
    sidebar: [
      { label: 'Overview', slug: '' }, { label: 'Quick Start', slug: 'quick-start' },
      { label: 'Concepts', slug: 'concepts' }, { label: 'Guides', slug: 'guides' },
      { label: 'Architecture', slug: 'architecture' }, { label: 'Reference', slug: 'reference' },
      { label: 'Troubleshooting', slug: 'troubleshooting' },
    ],
  })],
  vite: { plugins: [tailwindcss()] },
});
