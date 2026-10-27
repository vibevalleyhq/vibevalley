import type { RuntimeInfo } from "@vibevalley/protocol";

/** The catalog's label for it; the runtime's id when the catalog does not list it. */
export const runtimeName = (catalog: readonly RuntimeInfo[], runtime: string) => catalog.find((r) => r.id === runtime)?.preset.label ?? runtime;
