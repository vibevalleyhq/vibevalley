import type { RuntimeInfo } from "@vibevalley/protocol";

/** A runtime's name as the catalog labels it. */
export const runtimeName = (catalog: readonly RuntimeInfo[], runtime: string) => catalog.find((r) => r.id === runtime)?.preset.label ?? runtime;
