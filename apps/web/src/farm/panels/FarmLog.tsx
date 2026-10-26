// The farm's log: what you and the orchestrator said in the general channel and every helper's turn report, newest first.
// Voice captions carry no times, so the log keeps to the typed lines.

import { farmWording } from "../words";
import { wording } from "@vibevalley/protocol/words";
import { For, Show } from "solid-js";
import type { ChatMessage, WorkspaceState, Issue, Outcome } from "@vibevalley/protocol";
import { generalOf, messagesIn, spentText } from "../../rules/chat";
import { useCore } from "../../data/frame";
import { useAgent } from "../../data/agents";
import { AgentFace, OrchestratorFace } from "../../ui/Face";
import { DashedLine, PxMarkdown } from "../kit";

import { clockOf, FarmEmpty, FarmTag } from "./bits";
import { usePrefs } from "../../data/prefs";

const outcomeTag: Record<Outcome, [text: string, fill: string, ink: string]> = {
  completed: [wording().outcome.completed, "#efcf92", "#2f1f13"],
  failed: [wording().outcome.failed, "#f0cda6", "#c84a3a"],
  interrupted: [wording().outcome.interrupted, "#e2c995", "#67482d"],
};

/** The turn reports, newest first. */
const turnReportsOf = (s: WorkspaceState | undefined) => (s?.chat?.messages ?? []).filter((m) => m.kind === "report" && m.final).sort((a, b) => b.at - a.at);

const issueOfSession = (s: WorkspaceState | undefined, session: string): Issue | undefined =>
  (s?.issues ?? []).find((i) => i.sessions.some((s) => s === session));

type Row = { kind: "said" | "report"; message: ChatMessage };

export function FarmLog() {
  const core = useCore();
  const look = usePrefs((p) => p.orchestratorLook);
  const rows = (): Row[] => {
    const s = core();
    const chat = s?.chat;
    return [
      ...messagesIn(chat, generalOf(chat)?.id ?? "")
        .filter((m) => m.kind === "chat" && (m.fromKind === "owner" || m.fromKind === "orchestrator"))
        .map((message) => ({ kind: "said" as const, message })),
      ...turnReportsOf(s).map((message) => ({ kind: "report" as const, message })),
    ].sort((a, b) => b.message.at - a.message.at);
  };
  return (
    <Show when={rows().length > 0} fallback={<FarmEmpty text={farmWording().log.empty} />}>
      <div class="flex flex-col">
        <For each={rows().slice(0, 80)} keyed={(row) => row.message.id}>
          {(row, i) => (
            <div>
              <Show when={i() > 0}>
                <DashedLine />
              </Show>
              <div class="flex items-start gap-2.5 py-2">
                <span class="w-11 shrink-0 pt-1.5 text-right text-[12px] text-bark-400">{clockOf(row().message.at)}</span>
                <Show
                  when={row().kind === "said"}
                  fallback={<Report r={row().message} issue={issueOfSession(core(), row().message.session ?? row().message.from)} />}
                >
                  <Said m={row().message} look={look()} />
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function Said(props: { m: ChatMessage; look: string }) {
  const you = () => props.m.fromKind === "owner";
  return (
    <>
      <Show when={you()} fallback={<OrchestratorFace size={32} look={props.look} />}>
        <span class="flex h-8 w-8 shrink-0 items-center justify-center bg-leaf-500 text-[12px] text-cream-50">{farmWording().log.you}</span>
      </Show>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="text-[13px]">{you() ? farmWording().log.you : farmWording().orchestrator}</span>
          <FarmTag text={you() ? farmWording().log.said : props.m.final ? farmWording().log.answered : farmWording().log.saying} ink="#67482d" />
        </div>
        <div class={["mt-0.5 text-[13px]", you() ? "text-bark-900" : "text-bark-800"]}>
          <PxMarkdown text={props.m.text} />
        </div>
      </div>
    </>
  );
}

function Report(props: { r: ChatMessage; issue?: Issue }) {
  const core = useCore();
  const session = () => core()?.sessions.find((s) => s.id === (props.r.session ?? props.r.from));
  const agentId = () => props.r.agent ?? session()?.agent;
  const agent = useAgent(agentId);
  const outcome = () => props.r.outcome ?? "completed";
  return (
    <>
      <AgentFace agentId={agentId() ?? ""} look={agent()?.look} runtime={session()?.runtime ?? agent()?.runtime} size={32} />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="text-[13px]">{props.r.name}</span>
          <FarmTag text={outcomeTag[outcome()][0]} fill={outcomeTag[outcome()][1]} ink={outcomeTag[outcome()][2]} />
        </div>
        <Show when={props.issue}>
          <p class="mt-0.5 text-[13px]">{props.issue!.title}</p>
        </Show>
        <p class={["line-clamp-4 text-[12px]", outcome() === "failed" ? "text-berry" : "text-bark-600"]}>{props.r.text}</p>
        <Show when={props.r.spent}>{(spent) => <p class="text-[12px] text-bark-400">{farmWording().log.spent(spentText(spent()))}</p>}</Show>
      </div>
    </>
  );
}
