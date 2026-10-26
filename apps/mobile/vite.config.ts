import { defineConfig } from "vite-plus";

export default defineConfig({ test: { include: ["src/**/*.test.ts"] }, run: { tasks: { test: "vp test run" } } });
