// The island at the notch (apps/island): a native helper this process starts and feeds. The farm at a glance comes from
// the server's state stream, read here rather than by the page, so that it goes on with the window closed. Each change
// goes to the helper as one line on its stdin; a click on a row comes back on its stdout as the issue to open.

import { t } from "@vibevalley/i18n";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { type Attention, readStream, type StateFrame, statePath } from "@vibevalley/protocol";
import { attentionWantsOwner, phaseText } from "@vibevalley/protocol/rules";

/** How a row is drawn. The shapes here are apps/island IslandCore Messages.swift's; keep the two the same. */
export type Tone = "working" | "waiting" | "stuck";

export interface IslandRow {
  issue: string;
  number: number;
  title: string;
  /** Who works it and what it is doing, or what it waits on. */
  doing: string;
  tone: Tone;
}

export interface Glance {
  working: number;
  /** Issues that want the owner: asked, handed back, stuck. */
  waiting: number;
  /** The strip's words for the two counts, in the farm's language. */
  strip: { working: string; waiting: string };
  /** Those waiting first, then those at work; by number within each. */
  rows: IslandRow[];
}

/** Which issues the island shows, and how; the rest are not in flight. */
const toneOf: Record<Attention, Tone | undefined> = {
  draft: undefined,
  queued: undefined,
  working: "working",
  asking: "waiting",
  reviewing: "waiting",
  stuck: "stuck",
  done: undefined,
  canceled: undefined,
};

export function glanceOf(frame: StateFrame, now: number): Glance {
  const rows: (IslandRow & { first: boolean })[] = [];
  for (const issue of frame.state.issues) {
    const { state, stuck } = issue.attention;
    const tone = toneOf[state];
    if (!tone) continue;
    const head = frame.state.sessions.find((h) => h.id === issue.sessions.at(-1));
    const doing = tone === "working" && head ? `${head.name} · ${phaseText(head, now)}` : stuck ? t(`shared.stuck.${stuck}`) : t(`shared.attention.${state}`);
    rows.push({ issue: issue.id, number: issue.number, title: issue.title, doing, tone, first: attentionWantsOwner(state) });
  }
  rows.sort((a, b) => (b.first !== a.first ? Number(b.first) - Number(a.first) : a.number - b.number));
  const working = rows.filter((r) => r.tone === "working").length;
  const waiting = rows.filter((r) => r.first).length;
  return {
    working,
    waiting,
    strip: { working: working > 0 ? t("desktop.working", { n: working }) : t("desktop.idle"), waiting: t("desktop.waiting", { n: waiting }) },
    rows: rows.map(({ first: _, ...row }) => row),
  };
}

export interface IslandOptions {
  /** The helper; absent (not built, not macOS), the glance is still kept, for the tests. */
  binary: string | undefined;
  /** The page's pixel font, for the helper to read like the farm. */
  font: string;
  /** The server's address as it is now: a restart in development keeps the port. */
  server: () => string;
  /** A row was clicked. */
  open: (issue: string) => void;
}

/** What the desktop test reads (apps/desktop/test): the last glance, whether the helper runs, and its click. */
export interface IslandProbe {
  glance: Glance | undefined;
  helper: boolean;
  open: (issue: string) => void;
}

export function startIsland(o: IslandOptions): { stop: () => void } {
  const abort = new AbortController();
  let helper: ChildProcess | undefined;
  let last = "";
  const probe: IslandProbe = { glance: undefined, helper: false, open: o.open };
  Object.assign(globalThis, { vibevalleyIsland: probe });

  const send = (glance: Glance) => {
    probe.glance = glance;
    const line = JSON.stringify({ glance });
    if (line === last) return;
    last = line;
    helper?.stdin?.write(line + "\n");
  };

  if (o.binary && existsSync(o.binary)) {
    const child = spawn(o.binary, ["--font", o.font], { stdio: ["pipe", "pipe", "inherit"] });
    helper = child;
    probe.helper = true;
    // Its stdin closing is what makes it quit; a write after it went is dropped.
    child.stdin.on("error", () => undefined);
    child.once("exit", (code) => {
      helper = undefined;
      probe.helper = false;
      if (!abort.signal.aborted) console.error(`vibevalley: the island quit (${code}); it is not started again until the app is`);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const said: unknown = JSON.parse(line);
        const open = typeof said === "object" && said !== null && "open" in said ? said.open : undefined;
        if (typeof open === "string") o.open(open);
      } catch {
        // Not a line it means for us.
      }
    });
  }

  // Reconnects a second after the stream drops (the server restarting, in development).
  const follow = () => {
    readStream(o.server(), statePath, (frame) => send(glanceOf(frame, Date.now())), abort.signal).catch(() => {
      if (!abort.signal.aborted) setTimeout(follow, 1000);
    });
  };
  follow();

  return {
    stop: () => {
      abort.abort();
      helper?.stdin?.end();
    },
  };
}
