import { createSignal, onSettled } from "solid-js";

import type { SettingsUpdate } from "@vibevalley/protocol";
import type { UpdateState } from "@vibevalley/protocol/host";

import { api } from "./api";
import { currentHost } from "./host";
import { queries } from "./query";

/** Saves, and the settings the server answers with are the cached ones from then on. */
export async function saveSettings(update: SettingsUpdate) {
  const saved = await api.setting.update(update);
  queries.setQueryData(["settings"], saved);
  return saved;
}

/**
 * The desktop's own update as it is now and as it changes (Host.update); undefined where the host is not updated from
 * here, or until it has said.
 */
export function useUpdates() {
  const [state, setState] = createSignal<UpdateState | undefined>(undefined);
  onSettled(() => currentHost().update?.watch((s) => setState(() => s)));
  return state;
}
