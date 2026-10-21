import { defineConfig, lazyPlugins } from "vite-plus";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

// In a browser tab (vite dev) the API is the server on its usual port; served by the server, it is the same origin.
export default defineConfig({
  plugins: lazyPlugins(() => [solid(), tailwindcss()]),
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
