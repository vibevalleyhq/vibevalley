import type { MachineInfo, MachinePlatform, MachineStatus, RuntimeInfo, SessionsSlice } from "@vibevalley/protocol";

import { sortRuntimes } from "../../infra/agents";
import { api } from "../../infra/api";
import { useSessionsSlice } from "../../infra/frame";
import { defineQuery, ready, useQuery } from "../../infra/query";

type SliceMachine = SessionsSlice["machines"][number];
type MachineRuntimeSummary = MachineInfo["runtimes"][number];

export const machinesQuery = defineQuery({
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
  readonly worktreeSupported?: boolean | undefined;
  readonly joinedAt?: number | undefined;
  readonly lastSeenAt?: number | undefined;
  readonly runtimes: readonly string[];
  readonly runtimeSummaries: readonly MachineRuntimeSummary[];
}

export type MachineKind = "local" | "remote" | "sandbox";

export interface MachineRuntimeEntry {
  readonly key: string;
  readonly machineId: string;
  readonly runtimeId: string;
  readonly label: string;
  readonly info?: RuntimeInfo | undefined;
  readonly summary?: MachineRuntimeSummary | undefined;
  readonly enabled: boolean;
  readonly available: boolean;
}

export interface MachineRuntimeGroup {
  readonly machine: DisplayMachine;
  readonly runtimes: readonly MachineRuntimeEntry[];
}

export interface SelectedMachineRuntime {
  readonly machine: DisplayMachine;
  readonly entry: MachineRuntimeEntry;
}

export function machineKindOf(machine: Pick<DisplayMachine, "here" | "ephemeral">): MachineKind {
  if (machine.here) return "local";
  return machine.ephemeral ? "sandbox" : "remote";
}

/** Whether a probed coding engine is actually installed on its machine. */
function isRuntimeInstalled(info: RuntimeInfo): boolean {
  if (info.installation.status === "available") return true;
  // `unsupported` with a `signInCommand` means oar located the binary (`LoginRequired`), awaiting login.
  if (info.installation.status === "unsupported" && Boolean(info.installation.signInCommand)) return true;
  return false;
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
      worktreeSupported: info.worktreeSupported,
      joinedAt: info.joinedAt,
      lastSeenAt: info.lastSeenAt,
      runtimes: info.runtimes.filter((r) => r.available).map((r) => r.id),
      runtimeSummaries: info.runtimes,
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
      worktreeSupported: existing?.worktreeSupported,
      joinedAt: live.joinedAt ?? existing?.joinedAt,
      lastSeenAt: existing?.lastSeenAt,
      runtimes,
      runtimeSummaries: existing?.runtimeSummaries ?? [],
    });
  }

  return [...byId.values()].toSorted((a, b) => {
    if (a.here !== b.here) return a.here ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

/**
 * Groups installed coding engines by execution machine.
 * Uninstalled engines are strictly omitted; machines with 0 installed engines are omitted.
 */
export function buildMachineRuntimeGroups(
  machines: readonly DisplayMachine[],
  runtimes: readonly RuntimeInfo[],
  localFallbackName: string,
): MachineRuntimeGroup[] {
  const presetLabelById = new Map<string, string>();
  const infosByMachine = new Map<string, RuntimeInfo[]>();
  for (const info of runtimes) {
    presetLabelById.set(info.id, info.preset.label);
    const mid = info.machineId && info.machineId !== "" ? info.machineId : "local";
    const bucket = infosByMachine.get(mid);
    if (bucket) bucket.push(info);
    else infosByMachine.set(mid, [info]);
  }

  const orderedMachines: DisplayMachine[] = [...machines];
  const hasLocalMachine = orderedMachines.some((m) => m.here || m.id === "local");
  const localInstalled = (infosByMachine.get("local") ?? []).some(isRuntimeInstalled);
  if (!hasLocalMachine && localInstalled) {
    orderedMachines.unshift({
      id: "local",
      name: localFallbackName,
      here: true,
      ephemeral: false,
      platform: "macos",
      status: "online",
      runtimes: [],
      runtimeSummaries: [],
    });
  }

  const knownMachineIds = new Set(orderedMachines.map((m) => m.id));
  for (const [mid, list] of infosByMachine.entries()) {
    if (mid === "local" || knownMachineIds.has(mid)) continue;
    if (!list.some(isRuntimeInstalled)) continue;
    orderedMachines.push({
      id: mid,
      name: mid,
      here: false,
      ephemeral: false,
      platform: "other",
      status: "online",
      runtimes: [],
      runtimeSummaries: [],
    });
  }

  const groups: MachineRuntimeGroup[] = [];
  for (const machine of orderedMachines) {
    const rawInfos = infosByMachine.get(machine.id) ?? (machine.here ? (infosByMachine.get("local") ?? []) : []);
    const sortedInfos = sortRuntimes(rawInfos);
    const summaryById = new Map(machine.runtimeSummaries.map((s) => [s.id, s]));
    const entries: MachineRuntimeEntry[] = [];
    const seen = new Set<string>();
    const rejected = new Set<string>();

    for (const info of sortedInfos) {
      if (isRuntimeInstalled(info)) {
        seen.add(info.id);
        entries.push({
          key: `${machine.id}/${info.id}`,
          machineId: machine.id,
          runtimeId: info.id,
          label: info.preset.label,
          info,
          summary: summaryById.get(info.id),
          enabled: info.settings.enabled,
          available: info.installation.status === "available",
        });
      } else {
        rejected.add(info.id);
      }
    }

    // For local machines with probed `runtime.list`, `runtime.list` is the sole installed truth
    // (because `machine.list` reports all registered local adapters with `available: true`).
    const trustSummariesAndSlice = !machine.here || sortedInfos.length === 0;
    if (trustSummariesAndSlice) {
      for (const summary of machine.runtimeSummaries) {
        if (seen.has(summary.id) || rejected.has(summary.id)) continue;
        if (!summary.available) {
          rejected.add(summary.id);
          continue;
        }
        seen.add(summary.id);
        entries.push({
          key: `${machine.id}/${summary.id}`,
          machineId: machine.id,
          runtimeId: summary.id,
          label: summary.label || presetLabelById.get(summary.id) || summary.id,
          summary,
          enabled: true,
          available: true,
        });
      }

      for (const rid of machine.runtimes) {
        if (seen.has(rid) || rejected.has(rid)) continue;
        seen.add(rid);
        entries.push({
          key: `${machine.id}/${rid}`,
          machineId: machine.id,
          runtimeId: rid,
          label: presetLabelById.get(rid) ?? rid,
          enabled: true,
          available: true,
        });
      }
    }

    if (entries.length > 0) {
      groups.push({ machine, runtimes: entries });
    }
  }

  return groups;
}

/** Resolves `/runtimes/<machine>/<runtime>` against installed groups. */
export function resolveRuntimeSelection(groups: readonly MachineRuntimeGroup[], rest: string): SelectedMachineRuntime | undefined {
  const flat: SelectedMachineRuntime[] = [];
  for (const group of groups) {
    for (const entry of group.runtimes) {
      flat.push({ machine: group.machine, entry });
    }
  }
  if (flat.length === 0) return undefined;

  const trimmed = rest.replace(/^\/+|\/+$/gu, "");
  if (trimmed) {
    const parts = trimmed.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const machineId = decodeURIComponent(parts[0] ?? "");
      const runtimeId = decodeURIComponent(parts.slice(1).join("/"));
      const exact = flat.find((item) => item.machine.id === machineId && item.entry.runtimeId === runtimeId);
      if (exact) return exact;
    }
  }

  return flat[0];
}

export function useMergedMachines(): () => DisplayMachine[] {
  const sessions = useSessionsSlice();
  const listed = useQuery(machinesQuery, { interval: () => 30_000 });
  return () => mergeMachines(sessions()?.machines, ready(listed, []));
}
