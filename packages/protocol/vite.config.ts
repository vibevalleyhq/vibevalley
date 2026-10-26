import { defineConfig } from "vite-plus";

// The rules read local times of day (schedules, the patrol) and the golden data was recorded at UTC+8: every machine,
// CI included, runs the tests there.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], env: { TZ: "Asia/Shanghai" } }, run: { tasks: { test: "vp test run" } } });
