import { defineConfig } from "vite-plus";

export default defineConfig({ test: { include: ["test/**/*.test.ts"] }, run: { tasks: { test: "vp test run" } } });
