import type { IssueAct, OrchestratorState, Outcome, Phase, SessionClose } from "@vibevalley/protocol";

export { ago, numberText } from "../../rules/time";

/** The farm's words for an issue's acts where they are its own: completing a change is a harvest here. */
export const farmActWords: Partial<Record<IssueAct, string>> = { complete: "收获" };

const closedLabel: Record<SessionClose, string> = {
  merged: "收获了",
  completed: "完成了",
  dismissed: "收工了",
  lost: "目录丢了",
};

export function phaseLabel(phase: Phase): string {
  switch (phase._tag) {
    case "arriving":
      return "进场";
    case "working":
      return "干活中";
    case "done":
      return "完工";
    case "failed":
      return "出故障";
    case "resting":
      return "歇着";
    case "closed":
      return closedLabel[phase.closed];
  }
}

export const orchestratorLabel: Record<OrchestratorState, string> = { idle: "没开工", listening: "在听", thinking: "在想", speaking: "在说" };

export const outcomeLabel: Record<Outcome, string> = { completed: "完成", failed: "失败", interrupted: "叫停" };

export const runtimeLabel: Record<string, string> = { claude: "Claude", codex: "Codex" };
