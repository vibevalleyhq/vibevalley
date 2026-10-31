// The runtimes the farm knows (presets.json): their order, names and looks, what each takes before it is probed, and the
// settings a new one starts with, in the farm's language. presets.en.json says the same but for its words (agent/seed.test.ts).

import { Schema } from "effect";

import type { RuntimeFacts, RuntimePreset, RuntimeSettings } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { localizedJson } from "@/base/json.ts";

import presetsEn from "./presets.en.json";
import presetsZh from "./presets.json";

const Presets = Schema.Struct({
  defaultSettings: S.RuntimeSettings,
  fallbackPreset: S.RuntimePreset,
  runtimePresets: Schema.Array(S.RuntimePreset),
  runtimeFacts: Schema.Record(Schema.String, S.RuntimeFacts),
  runtimeIds: Schema.Array(Schema.String),
});
const presets = localizedJson(Presets, presetsZh, presetsEn);

export const defaultSettings = (): RuntimeSettings => ({ ...presets().defaultSettings, env: {} });

/** Every runtime the farm knows, in the order the page shows them. */
export const runtimeIds = (): string[] => [...presets().runtimeIds];

/** A runtime's name, look and blurb; one the farm has no look for gets the fallback, named by its id. */
export function presetOf(runtime: string): RuntimePreset {
  const found = presets().runtimePresets.find((p) => p.id === runtime);
  return structuredClone(found ?? { ...presets().fallbackPreset, id: runtime, label: runtime });
}

export const runtimeLabel = (runtime: string) => presetOf(runtime).label;

/** What the farm knows a runtime takes before probing it: for one it has no word on, nothing beyond a prompt. */
export function factsOf(runtime: string): RuntimeFacts {
  const facts = presets().runtimeFacts[runtime];
  return facts ? structuredClone(facts) : { steer: false, refused: {}, capabilities: [], inProcess: false };
}
