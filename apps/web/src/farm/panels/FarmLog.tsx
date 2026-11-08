import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ChatMessage, SpaceState, Issue, Outcome } from "@vibevalley/protocol";
import { defaultOf, sessionIdsOf } from "@vibevalley/protocol/rules";

import { spentText } from "#/base/format.ts";
import { useFollowed, useReports } from "#/features/channel/index.ts";
import { useAgent } from "#/infra/agents.ts";
import { useCore } from "#/infra/frame.ts";
import { AgentFace, OrchestratorFace } from "#/ui/Face.tsx";
import { DashedLine, PxMarkdown } from "#/ui/pixel/index.ts";

import { clockOf, FarmEmpty, FarmTag } from "./rows";

const variantStyles = stylex.create({
  saidDiv: {
    marginTop: "calc(var(--spacing) * .5)",
    fontSize: "13px",
  },
  saidDivVariant: {
    color: "var(--color-bark-900)",
  },
  saidDivVariant2: {
    color: "var(--color-bark-800)",
  },
  reportP: {
    WebkitLineClamp: "4",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "12px",
  },
  reportPVariant: {
    color: "var(--color-berry)",
  },
  reportPVariant2: {
    color: "var(--color-bark-600)",
  },
});

const viewStyles = stylex.create({
  farmLogDiv: {
    display: "flex",
    flexDirection: "column",
  },
  farmLogDiv2: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  farmLogSpan: {
    width: "calc(var(--spacing) * 11)",
    flexShrink: "0",
    paddingTop: "calc(var(--spacing) * 1.5)",
    textAlign: "right",
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
  saidSpan: {
    display: "flex",
    height: "calc(var(--spacing) * 8)",
    width: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "var(--color-leaf-500)",
    fontSize: "12px",
    color: "var(--color-bark-900)",
  },
  saidDiv: {
    minWidth: "0",
    flex: "1",
  },
  saidDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  saidSpan2: {
    fontSize: "13px",
  },
  reportP: {
    marginTop: "calc(var(--spacing) * .5)",
    fontSize: "13px",
  },
  reportP2: {
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
});

const outcomeTag: Record<Outcome, [text: string, fill: string, ink: string]> = {
  completed: [t("shared.outcome.completed"), "#efcf92", "#2f1f13"],
  failed: [t("shared.outcome.failed"), "#f0cda6", "#c84a3a"],
  interrupted: [t("shared.outcome.interrupted"), "#e2c995", "#67482d"],
};

const issueOfSession = (s: SpaceState | undefined, session: string): Issue | undefined =>
  (s?.issues ?? []).find((i) => sessionIdsOf(i).some((id) => id === session));

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
    ].toSorted((a, b) => b.message.at - a.message.at);
  return (
    <Show when={rows().length > 0} fallback={<FarmEmpty text={t("web.farm.log.empty")} />}>
      <div {...stylex.attrs(viewStyles.farmLogDiv)}>
        <For each={rows().slice(0, 80)} keyed={(row) => row.message.id}>
          {(row, i) => (
            <div>
              <Show when={i() > 0}>
                <DashedLine />
              </Show>
              <div {...stylex.attrs(viewStyles.farmLogDiv2)}>
                <span {...stylex.attrs(viewStyles.farmLogSpan)}>{clockOf(row().message.at)}</span>
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
        <span {...stylex.attrs(viewStyles.saidSpan)}>{t("web.farm.log.you")}</span>
      </Show>
      <div {...stylex.attrs(viewStyles.saidDiv)}>
        <div {...stylex.attrs(viewStyles.saidDiv2)}>
          <span {...stylex.attrs(viewStyles.saidSpan2)}>{you() ? t("web.farm.log.you") : t("web.farm.orchestrator")}</span>
          <FarmTag text={you() ? t("web.farm.log.said") : t("web.farm.log.answered")} ink="#67482d" />
        </div>
        <div {...stylex.attrs(variantStyles.saidDiv, you() ? variantStyles.saidDivVariant : variantStyles.saidDivVariant2)}>
          <PxMarkdown text={props.m.text} />
        </div>
      </div>
    </>
  );
}

function Report(props: { r: ChatMessage; issue?: Issue | undefined }) {
  const core = useCore();
  const session = () => core()?.sessions.find((s) => s.id === (props.r.session ?? props.r.from));
  const agentId = () => props.r.agent ?? session()?.agent;
  const agent = useAgent(agentId);
  const outcome = () => props.r.outcome ?? "completed";
  return (
    <>
      <AgentFace agentId={agentId() ?? ""} look={agent()?.look} runtime={session()?.runtime ?? agent()?.runtime} size={32} />
      <div {...stylex.attrs(viewStyles.saidDiv)}>
        <div {...stylex.attrs(viewStyles.saidDiv2)}>
          <span {...stylex.attrs(viewStyles.saidSpan2)}>{props.r.name}</span>
          <FarmTag text={outcomeTag[outcome()][0]} fill={outcomeTag[outcome()][1]} ink={outcomeTag[outcome()][2]} />
        </div>
        <Show when={props.issue}>
          <p {...stylex.attrs(viewStyles.reportP)}>{props.issue!.title}</p>
        </Show>
        <p {...stylex.attrs(variantStyles.reportP, outcome() === "failed" ? variantStyles.reportPVariant : variantStyles.reportPVariant2)}>{props.r.text}</p>
        <Show when={props.r.spent}>{(spent) => <p {...stylex.attrs(viewStyles.reportP2)}>{t("web.farm.log.spent", { spent: spentText(spent()) })}</p>}</Show>
      </div>
    </>
  );
}
