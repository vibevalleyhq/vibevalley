// What the owner does to the farm: each calls the server, then plays the bed's effect.
// A refusal is the server's to tell (a notice), so most callers fire and forget (`fire`).

import { farmWording } from "./words";
import { wording } from "@vibevalley/protocol/words";
import type { IssueAct, Session, StateFrame } from "@vibevalley/protocol";
import { api, newSendKey } from "../base/api";
import { actionOf, perform } from "../features/issue";
import { farm, farmState } from "./store";
import { actForTool, aimTool, type BedFxKind, type PlotAim, type Tool, type ToolResult } from "./tools";
import { type Bed, bedOfStation, issueOf, plotOf, sessionAtStation, stationOfSession } from "./world/plots";
import { webRoutes, type YardPlace } from "./world/places";

/** A refusal is the server's to tell (a notice). */
export const fire = (command: Promise<unknown>) => void command.catch(() => {});

const fx = (s: Session, kind: BedFxKind, text?: string) => {
  const bed = bedOfStation(stationOfSession(s));
  if (bed) farm.bedFx(bed.index, kind, text);
};

export interface FarmCommands {
  /** Words for a helper; one at work hears them mid-turn. */
  water(s: Session, text: string, sendKey?: string): Promise<void>;
  /** The server tells it what its conflicts are and to settle them. */
  resolve(s: Session): Promise<void>;
  cure(s: Session): Promise<void>;
  harvest(s: Session): Promise<void>;
  /** Stops one at work; asks one not at work to leave. */
  shovel(s: Session): Promise<void>;
  stop(s: Session): Promise<void>;
  /** `station`: the plot it was sown on; `project`: the one chosen on the sowing form. The orchestrator is told to sow it. */
  plant(text: string, o?: { station?: number; agent?: string; project?: string; sendKey?: string }): Promise<void>;
  /** The pointer's tool, target and hint, read from one frame. */
  aim(bed: Bed): PlotAim;
  /** Acts on a click; a tool that does not apply says why over the bed. */
  act(plot: PlotAim): Promise<ToolResult>;
  chooseTitle(achievement?: string, tier?: number): Promise<void>;
  refreshRuntime(id: string): Promise<void>;
}

/** The commands over the latest frame `frame()` gives. */
export function farmCommands(frame: () => StateFrame | undefined): FarmCommands {
  const issue = (s: Session) => frame()?.state.issues?.find((i) => i.id === issueOf(s));
  const send = async (s: Session, act: IssueAct, words = "", sendKey?: string) => {
    const found = issue(s);
    const action = found && actionOf(found, act);
    if (!found || !action) throw new Error(farmWording().command.cannot(wording().act[act]));
    await perform(found, action, words, sendKey);
  };
  const aimAt = (bed: Bed, tool: Tool): PlotAim => {
    const f = frame();
    const session = f ? sessionAtStation(f.state.sessions, bed.station) : undefined;
    const level = f ? Math.round(f.view.level.level) : 1;
    const plot = f ? plotOf(f.view, session) : { crop: "empty" as const };
    const current = session ? f?.state.issues?.find((i) => i.id === issueOf(session)) : undefined;
    return { bed, tool, session, aim: aimTool(tool, bed, session, plot, level, current) };
  };
  const commands: FarmCommands = {
    async water(s, text, sendKey) {
      await send(s, "tell", text, sendKey);
      fx(s, "water");
    },
    async resolve(s) {
      await send(s, "resolve");
      fx(s, "water");
    },
    async cure(s) {
      await send(s, "cure");
      fx(s, "spray");
    },
    async harvest(s) {
      await send(s, "complete");
      fx(s, "harvest", farmWording().command.stored);
    },
    async shovel(s) {
      const act = actForTool(
        "shovel",
        (issue(s)?.attention.acts ?? []).map((a) => a.act),
      );
      if (!act) throw new Error(farmWording().command.noShovel);
      await send(s, act);
      fx(s, "shovel");
    },
    stop: (s) => send(s, "stop"),
    async plant(text, o = {}) {
      const said = text.trim();
      if (!said) return;
      const id = frame()?.state.chat?.channels.find((c) => c.default)?.id;
      if (!id) return;
      await api.channel.message.send({ id, text: said, station: o.station, agent: o.agent, project: o.project, sendKey: o.sendKey ?? newSendKey() });
    },
    aim: (bed) => aimAt(bed, farmState().tool),
    async act({ bed, tool, session: pointed }) {
      const { session, aim } = aimAt(bed, tool);
      if (session?.id !== pointed?.id) return { kind: "refused", text: farmWording().command.changed };
      if (!aim.ok || !session) {
        if (aim.ok) return { kind: "sow", station: bed.station };
        farm.bedFx(bed.index, "note", aim.text);
        return { kind: "refused", text: aim.text };
      }
      switch (tool) {
        case "hand":
          return { kind: "inspect", sessionId: session.id };
        case "water":
          return { kind: "water", sessionId: session.id };
        case "bug":
          await commands.cure(session);
          return { kind: "done" };
        case "harvest":
          return { kind: "review", sessionId: session.id };
        case "shovel":
          await commands.shovel(session);
          return { kind: "done" };
        case "weed":
          return { kind: "done" };
      }
    },
    chooseTitle: (achievement, tier) => api.game.title.set({ achievement, tier }),
    refreshRuntime: async (id) => void (await api.runtime.refresh({ id })),
  };
  return commands;
}

/**
 * A click keeps its tool and target; the command checks the latest issue before acting. Returns the pointer's decision
 * so the caller can play its sound (a tap when it applies).
 */
export async function clickBed(commands: FarmCommands, bed: Bed): Promise<PlotAim> {
  const aim = commands.aim(bed);
  let got: ToolResult;
  try {
    got = await commands.act(aim);
  } catch {
    // The server said no: its notice says why.
    return aim;
  }
  switch (got.kind) {
    case "sow":
      farm.sow(got.station);
      break;
    case "inspect":
      farm.select(got.sessionId);
      break;
    case "water":
      farm.water(got.sessionId);
      break;
    case "review":
      farm.review(got.sessionId);
      break;
    case "done":
    case "refused":
      break;
  }
  return aim;
}

/** A click on a yard place: its panel, the chat, or its workbench page through `go` (the router's navigate). */
export function openPlace(place: YardPlace, go: (path: string) => void) {
  if (place.chat) farm.chatOpen(true);
  else if (place.panel) farm.panel(place.panel);
  else if (place.route && webRoutes.includes(place.route)) go(place.route);
}
