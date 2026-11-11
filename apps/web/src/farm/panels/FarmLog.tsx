import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ChatMessage, SpaceState, Issue, Outcome } from "@vibevalley/protocol";
import { actorRoleOf, defaultOf, sessionIdsOf } from "@vibevalley/protocol/rules";

import { spentText } from "#/base/format.ts";
import { useFollowed, useReports } from "#/features/channel/index.ts";
import { useAgent } from "#/infra/agents.ts";
import { useCore } from "#/infra/frame.ts";
import { AgentFace, OrchestratorFace } from "#/ui/domain/Face.tsx";
import { DashedLine, PxMarkdown } from "#/ui/pixel/index.ts";

import { clockOf, FarmEmpty, FarmTag } from "./rows";

const styles = stylex.create({
  saidBody: {
    marginTop: "0.125rem",
    fontSize: "13px",
  },
  saidYou: {
    color: "var(--color-bark-900)",
  },
  saidOrchestrator: {
    color: "var(--color-bark-800)",
  },
  reportSummary: {
    WebkitLineClamp: "4",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "12px",
  },
  reportFailed: {
    color: "var(--color-berry)",
  },
  reportNormal: {
    color: "var(--color-bark-600)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.625rem",
    paddingBlock: "0.5rem",
  },
  clock: {
    width: "2.75rem",
    flexShrink: "0",
    paddingTop: "0.375rem",
    textAlign: "right",
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
  youBadge: {
    display: "flex",
    height: "2rem",
    width: "2rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "var(--color-leaf-500)",
    fontSize: "12px",
    color: "var(--color-bark-900)",
  },
  content: {
    minWidth: "0",
    flex: "1",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  author: {
    fontSize: "13px",
  },
  saidTag: {
    color: "var(--color-bark-600)",
  },
  tagCompleted: {
    backgroundColor: "var(--color-log-ok-fill)",
    color: "var(--color-bark-900)",
  },
  tagFailed: {
    backgroundColor: "var(--color-log-fail-fill)",
    color: "var(--color-berry-500)",
  },
  tagInterrupted: {
    backgroundColor: "var(--color-cream-200)",
    color: "var(--color-bark-600)",
  },
  issueTitle: {
    marginTop: "0.125rem",
    fontSize: "13px",
  },
  spent: {
    fontSize: "12px",
    color: "var(--color-bark-400)",
  },
});

const outcomeTag: Record<Outcome, [text: string, look: stylex.StyleXStyles]> = {
  completed: [t("shared.outcome.completed"), styles.tagCompleted],
  failed: [t("shared.outcome.failed"), styles.tagFailed],
  interrupted: [t("shared.outcome.interrupted"), styles.tagInterrupted],
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
        .messages.filter((m) => m.kind === "chat" && (m.actor.kind === "user" || actorRoleOf(m.actor) === "orchestrator"))
        .map((message) => ({ kind: "said" as const, message })),
      ...reports().map((message) => ({ kind: "report" as const, message })),
    ].toSorted((a, b) => b.message.at - a.message.at);
  return (
    <Show when={rows().length > 0} fallback={<FarmEmpty text={t("web.farm.log.empty")} />}>
      <div {...stylex.attrs(styles.list)}>
        <For each={rows().slice(0, 80)} keyed={(row) => row.message.id}>
          {(row, i) => (
            <div>
              <Show when={i() > 0}>
                <DashedLine />
              </Show>
              <div {...stylex.attrs(styles.row)}>
                <span {...stylex.attrs(styles.clock)}>{clockOf(row().message.at)}</span>
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
  const you = () => props.m.actor.kind === "user";
  return (
    <>
      <Show when={you()} fallback={<OrchestratorFace size={32} agent={props.m.from} />}>
        <span {...stylex.attrs(styles.youBadge)}>{t("web.farm.log.you")}</span>
      </Show>
      <div {...stylex.attrs(styles.content)}>
        <div {...stylex.attrs(styles.header)}>
          <span {...stylex.attrs(styles.author)}>{you() ? t("web.farm.log.you") : t("web.farm.orchestrator")}</span>
          <FarmTag text={you() ? t("web.farm.log.said") : t("web.farm.log.answered")} styles={styles.saidTag} />
        </div>
        <div {...stylex.attrs(styles.saidBody, you() ? styles.saidYou : styles.saidOrchestrator)}>
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
      <div {...stylex.attrs(styles.content)}>
        <div {...stylex.attrs(styles.header)}>
          <span {...stylex.attrs(styles.author)}>{props.r.name}</span>
          <FarmTag text={outcomeTag[outcome()][0]} styles={outcomeTag[outcome()][1]} />
        </div>
        <Show when={props.issue}>{(issue) => <p {...stylex.attrs(styles.issueTitle)}>{issue().title}</p>}</Show>
        <p {...stylex.attrs(styles.reportSummary, outcome() === "failed" ? styles.reportFailed : styles.reportNormal)}>{props.r.text}</p>
        <Show when={props.r.spent}>{(spent) => <p {...stylex.attrs(styles.spent)}>{t("web.farm.log.spent", { spent: spentText(spent()) })}</p>}</Show>
      </div>
    </>
  );
}
