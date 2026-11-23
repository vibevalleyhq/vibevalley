import type { MachineInfo, MachinePlatform, MachineStatus, SessionsSlice } from "@vibevalley/protocol";

import { api } from "../../infra/api";
import { useSessionsSlice } from "../../infra/frame";
import { defineQuery, ready, useQuery } from "../../infra/query";

type SliceMachine = SessionsSlice["machines"][number];

const machinesQuery = defineQuery({
  key: () => ["machines"],
  fetch: (_: void, context) => api.machine.list(context),
});

export interface DisplayMachine {
  readonly id: string;
  readonly name: string;
  readonly here: boolean;
  readonly ephemeral: boolean;
  readonly platform: MachinePlatform;
  readonly status: MachineStatus;
  readonly runtimes: readonly string[];
}

export type MachineKind = "local" | "remote" | "sandbox";

export function machineKindOf(machine: Pick<DisplayMachine, "here" | "ephemeral">): MachineKind {
  if (machine.here) return "local";
  return machine.ephemeral ? "sandbox" : "remote";
}

function statusFromSlice(machine: SliceMachine): MachineStatus {
  if (machine.status !== undefined) return machine.status;
  return machine.online ? "online" : "offline";
}

/** Merges real-time `SessionsSlice.machines` with richer `machine.list` metadata, local machine first. */
function mergeMachines(sliceMachines: readonly SliceMachine[] | undefined, rpcMachines: readonly MachineInfo[] | undefined): DisplayMachine[] {
  const byId = new Map<string, DisplayMachine>();

  for (const info of rpcMachines ?? []) {
    byId.set(info.id, {
      id: info.id,
      name: info.name,
      here: info.here,
      ephemeral: info.ephemeral,
      platform: info.platform,
      status: info.status,
      runtimes: info.runtimes.filter((r) => r.available).map((r) => r.id),
    });
  }

  for (const live of sliceMachines ?? []) {
    const existing = byId.get(live.id);
    const runtimes = live.runtimes && live.runtimes.length > 0 ? live.runtimes : (existing?.runtimes ?? []);
    byId.set(live.id, {
      id: live.id,
      name: live.name || existing?.name || live.id,
      here: live.here,
      ephemeral: live.ephemeral ?? existing?.ephemeral ?? false,
      platform: live.platform ?? existing?.platform ?? "other",
      status: statusFromSlice(live),
      runtimes,
    });
  }

  return [...byId.values()].toSorted((a, b) => {
    if (a.here !== b.here) return a.here ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

export function useMergedMachines(): () => DisplayMachine[] {
  const sessions = useSessionsSlice();
  const listed = useQuery(machinesQuery, { interval: () => 30_000 });
  return () => mergeMachines(sessions()?.machines, ready(listed, []));
}
