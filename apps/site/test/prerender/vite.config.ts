import { fileURLToPath } from "node:url";

import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    solid({
      ssr: true,
      start: {
        app: fileURLToPath(new URL("./fixture/App.tsx", import.meta.url)),
        document: fileURLToPath(new URL("./fixture/Document.tsx", import.meta.url)),
        renderMode: "async",
      },
    }),
  ],
});
