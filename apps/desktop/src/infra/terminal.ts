import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { z } from "zod";

import type { Host } from "@vibevalley/protocol/host";

import { revealable } from "../base/boundary";
import { jsonLines } from "../base/lines";

type HostTerminal = NonNullable<Host["terminal"]>;
type PtySpawn = Parameters<HostTerminal["spawn"]>[0];
type PtySpawned = Awaited<ReturnType<HostTerminal["spawn"]>>;
type PtyWrite = Parameters<HostTerminal["write"]>[0];
type PtyResize = Parameters<HostTerminal["resize"]>[0];
type PtyInfo = Awaited<ReturnType<HostTerminal["inspect"]>>;
type PtyData = Parameters<Parameters<HostTerminal["onData"]>[0]>[0];
type PtyExit = Parameters<Parameters<HostTerminal["onExit"]>[0]>[0];

const PtyHelperEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("spawned"), id: z.string(), reqId: z.number().optional(), pid: z.number() }),
  z.object({ event: z.literal("data"), id: z.string(), data: z.string() }),
  z.object({ event: z.literal("exit"), id: z.string(), code: z.number() }),
  z.object({ event: z.literal("inspected"), id: z.string(), reqId: z.number().optional(), cwd: z.string(), command: z.string() }),
  z.object({ event: z.literal("killed"), id: z.string(), reqId: z.number().optional() }),
  z.object({ event: z.literal("error"), id: z.string(), reqId: z.number().optional(), message: z.string() }),
]);

type HelperEvent = z.infer<typeof PtyHelperEvent>;

interface PendingCall {
  readonly resolve: (event: HelperEvent) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface TerminalManager {
  readonly spawn: (input: PtySpawn) => Promise<PtySpawned>;
  readonly write: (input: PtyWrite) => void;
  readonly resize: (input: PtyResize) => void;
  readonly kill: (id: string) => void;
  readonly inspect: (id: string) => Promise<PtyInfo>;
  readonly stop: () => void;
}

export function startTerminals(o: {
  readonly binary: string | undefined;
  readonly env: () => NodeJS.ProcessEnv;
  readonly roots: () => readonly string[];
  readonly onData: (event: PtyData) => void;
  readonly onExit: (event: PtyExit) => void;
}): TerminalManager {
  let helper: ChildProcess | undefined;
  let stopped = false;
  let seq = 1;
  const active = new Set<string>();
  const pending = new Map<number, PendingCall>();

  const failPending = (why: string) => {
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      pending.delete(id);
      call.reject(new Error(why));
    }
  };

  const ensureHelper = (): ChildProcess => {
    if (stopped) throw new Error("terminal helper is stopped");
    if (helper) return helper;
    if (!o.binary || !existsSync(o.binary)) {
      throw new Error("VibeValleyPty helper binary is unavailable on this platform");
    }
    const child = spawn(o.binary, [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: o.env(),
    });
    helper = child;
    child.stdin.on("error", () => undefined);
    jsonLines(child.stdout, PtyHelperEvent, (ev) => {
      switch (ev.event) {
        case "data":
          o.onData({ id: ev.id, data: ev.data });
          return;
        case "exit":
          active.delete(ev.id);
          o.onExit({ id: ev.id, code: ev.code });
          return;
        case "spawned":
        case "inspected":
        case "killed":
        case "error": {
          if (ev.reqId === undefined) return;
          const call = pending.get(ev.reqId);
          if (!call) return;
          clearTimeout(call.timer);
          pending.delete(ev.reqId);
          if (ev.event === "error") call.reject(new Error(ev.message));
          else call.resolve(ev);
          return;
        }
      }
    });
    child.once("exit", (code) => {
      if (helper === child) helper = undefined;
      failPending(`VibeValleyPty exited (${code ?? "signal"})`);
      const lost = [...active];
      active.clear();
      for (const id of lost) o.onExit({ id, code: code ?? -1 });
    });
    return child;
  };

  const send = (payload: Record<string, unknown>) => {
    if (stopped || !helper?.stdin) return;
    helper.stdin.write(JSON.stringify(payload) + "\n");
  };

  const request = (payload: Record<string, unknown>): Promise<HelperEvent> => {
    const child = ensureHelper();
    const reqId = seq++;
    return new Promise<HelperEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`terminal helper timed out (${String(payload.op)})`));
      }, 10_000);
      pending.set(reqId, { resolve, reject, timer });
      child.stdin?.write(JSON.stringify({ ...payload, reqId }) + "\n");
    });
  };

  return {
    spawn: async (input) => {
      const cwd = input.cwd.trim() || homedir();
      if (!revealable(cwd, o.roots())) {
        throw new Error(`terminal cwd is outside allowed roots: ${cwd}`);
      }
      const ev = await request({
        op: "spawn",
        id: input.id,
        cwd,
        cols: input.cols,
        rows: input.rows,
      });
      if (ev.event !== "spawned") throw new Error("unexpected helper response to spawn");
      active.add(input.id);
      return { pid: ev.pid };
    },
    write: (input) => {
      send({ op: "write", id: input.id, data: input.data });
    },
    resize: (input) => {
      send({ op: "resize", id: input.id, cols: input.cols, rows: input.rows });
    },
    kill: (id) => {
      send({ op: "kill", id });
    },
    inspect: async (id) => {
      if (!helper || !active.has(id)) return { cwd: "", command: "" };
      const ev = await request({ op: "inspect", id });
      if (ev.event !== "inspected") return { cwd: "", command: "" };
      return { cwd: ev.cwd, command: ev.command };
    },
    stop: () => {
      stopped = true;
      failPending("terminal helper stopped");
      active.clear();
      helper?.stdin?.end();
      helper = undefined;
    },
  };
}
