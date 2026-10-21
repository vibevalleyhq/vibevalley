import { defineConfig } from "vite-plus";

// Tests run real git and a database in every file at once: a slow machine under that load needs more than 5 s.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 20_000 } });
