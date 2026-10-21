// The site at vibevalley.dev: static pages, Chinese at / and English at /en/. The art and the pixel font are the
// game's own (apps/web/public), imported from there, so there is one copy of each. Styles are Tailwind (the game's theme
// in src/styles/global.css); the parts that move with the page are React islands, rendered at build time like the
// rest and brought to life in the browser.
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://vibevalley.dev',
  integrations: [react(), sitemap({ i18n: { defaultLocale: 'zh', locales: { zh: 'zh-CN', en: 'en' } } })],
  i18n: { locales: ['zh', 'en'], defaultLocale: 'zh', routing: { prefixDefaultLocale: false } },
  vite: {
    plugins: [tailwindcss()],
    // Pixel art keeps its pixels: no inlining into CSS as data URIs, every picture a file of its own.
    build: { assetsInlineLimit: 0 },
  },
})
