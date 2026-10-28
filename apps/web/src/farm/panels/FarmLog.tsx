import { t } from "@vibevalley/i18n";
// The farm's log: what you and the orchestrator said in the general channel and every helper's turn report, newest first.
// Voice captions carry no times, so the log keeps to the typed lines.

import { spentText } from "../../base/format";

import { wording } from "@vibevalley/protocol/words";
import { For, Show } from "solid-js";
import type { ChatMessage, WorkspaceState, Issue, Outcome } from "@vibevalley/protocol";
import { defaultOf, useFollowed, useReports } from "../../features/channel";
import { useCore } from "../../base/frame";
import { useAgent } from "../../base/agents";
import { AgentFace, OrchestratorFace } from "../../ui/Face";
import { DashedLine, PxMarkdown } from "../../ui/pixel";

import { clockOf, FarmEmpty, FarmTag } from "./bits";

const outcomeTag: Record<Outcome, [text: string, fill: string, ink: string]> = {
  completed: [wording().outcome.completed, "#efcf92", "#2f1f13"],
  failed: [wording().outcome.failed, "#f0cda6", "#c84a3a"],
  interrupted: [wording().outcome.interrupted, "#e2c995", "#67482d"],
};

const issueOfSession = (s: WorkspaceState | undefined, session: string): Issue | undefined =>
  (s?.issues ?? []).find((i) => i.sessions.some((s) => s === session));

type Row = { kind: "said" | "report"; message: ChatMessage };

export function FarmLog() {
  const core = useCore();
  const general = useFollowed(() => defaultOf(core()?.chat)?.id);
  const reports = useReports();
  const rows = (): Row[] =>
    [
      ...general()
        .messages.filter((m) => m.kind === "chat" && (m.fromKind === "owner" || m.fromKind === "orchestrator"))
        .map((message) => ({ kind: "said" as const, message })),
      ...reports().map((message) => ({ kind: "report" as const, message })),
    ].sort((a, b) => b.message.at - a.message.at);
  return (
    <Show when={rows().length > 0} fallback={<FarmEmpty text={t("web.farm.log.empty")} />}>
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
                  <Said m={row().message} />
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function Said(props: { m: ChatMessage }) {
  const you = () => props.m.fromKind === "owner";
  return (
    <>
      <Show when={you()} fallback={<OrchestratorFace size={32} agent={props.m.from} />}>
        <span class="flex h-8 w-8 shrink-0 items-center justify-center bg-leaf-500 text-[12px] text-cream-50">{t("web.farm.log.you")}</span>
      </Show>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <span class="text-[13px]">{you() ? t("web.farm.log.you") : t("web.farm.orchestrator")}</span>
          <FarmTag text={you() ? t("web.farm.log.said") : t("web.farm.log.answered")} ink="#67482d" />
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
        <Show when={props.r.spent}>{(spent) => <p class="text-[12px] text-bark-400">{t("web.farm.log.spent", { spent: spentText(spent()) })}</p>}</Show>
      </div>
    </>
  );
}
