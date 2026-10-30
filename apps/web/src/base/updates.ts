// The desktop's own update as it is now and as it changes (Host.update); undefined where the host is not updated from
// here, or until it has said.

import { createSignal, onSettled } from "solid-js";

import type { UpdateState } from "@vibevalley/protocol/host";

import { currentHost } from "./host";

export function useUpdates() {
  const [state, setState] = createSignal<UpdateState | undefined>(undefined);
  onSettled(() => currentHost().update?.watch((s) => setState(() => s)));
  return state;
}
