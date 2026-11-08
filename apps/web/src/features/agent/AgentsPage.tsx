import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createMemo, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Agent, type AgentTally, defaultOrchestrator, type RuntimeInfo } from "@vibevalley/protocol";

import { orchestratorHref } from "#/features/orchestrator/index.ts";
import { useSkills } from "#/features/runtime/index.ts";
import { useAgentProblems, useOrchestrators, useWorkAgents } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useQueryClient, ready, useRuntimes } from "#/infra/query.ts";
import { Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { hexColor } from "#/ui/cast.ts";
import { AgentFace, OrchestratorFace } from "#/ui/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";

import { AgentPage } from "./AgentPage";
import { TemplatesPage } from "./TemplatesPage";

const recipeStyles2 = stylex.create({
  cardShellA: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    borderRadius: "var(--radius-lg)",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--color-ink) 20%, transparent)",
        },
      },
    },
    backgroundColor: {
      default: "var(--color-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-page)",
      },
    },
    padding: "calc(var(--spacing) * 4)",
    transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: "var(--default-transition-duration)",
    outlineStyle: {
      default: null,
      ":focus-visible": "solid",
    },
    outlineWidth: {
      default: null,
      ":focus-visible": "2px",
    },
    outlineColor: {
      default: null,
      ":focus-visible": "var(--color-focus)",
    },
  },
  cardShellAVariant1Case1: {
    borderStyle: "solid",
  },
  cardShellAVariant1Case2: {
    borderStyle: "dashed",
  },
});

const recipeStyles = stylex.create({
  agentsPageA: {
    display: "inline-flex",
    height: "calc(var(--spacing) * 7)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  agentsPageA2: {
    display: "inline-flex",
    height: "calc(var(--spacing) * 7)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-accent)",
    backgroundColor: {
      default: "var(--color-accent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-accent-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-page)",
  },
  agentsPageA3: {
    display: "flex",
    minHeight: "calc(var(--spacing) * 32)",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "dashed",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-ink)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink) 20%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-leaf)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--color-leaf) 60%, transparent)",
        },
      },
    },
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ok-ink)",
      },
    },
  },
  agentsPageA4: {
    color: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  agentsPageA5: {
    display: "flex",
    minHeight: "calc(var(--spacing) * 44)",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "dashed",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-ink)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink) 20%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-leaf)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--color-leaf) 60%, transparent)",
        },
      },
    },
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ok-ink)",
      },
    },
  },
  orchestratorCardDiv: {
    marginTop: "auto",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingTop: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
});

const variantStyles2 = stylex.create({
  orchestratorCardSpan: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
});

const variantStyles = stylex.create({
  agentCardSpan: {
    width: "7px",
    height: "7px",
    flexShrink: "0",
    borderRadius: "2147483647px",
  },
  agentCardSpanVariant: {
    backgroundColor: "var(--color-leaf)",
  },
  agentCardSpanVariant2: {
    backgroundColor: "var(--color-berry)",
  },
});

const viewStyles = stylex.create({
  agentsPageDiv: {
    height: "100%",
    overflowY: "auto",
  },
  agentsPageDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 6)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingTop: "calc(var(--spacing) * 4)",
    paddingBottom: "calc(var(--spacing) * 8)",
  },
  agentsPageDiv3: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "flex-end",
    gap: "calc(var(--spacing) * 3)",
  },
  agentsPageSpan: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  agentsPageH2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  agentsPageDiv4: {
    display: "grid",
    gap: "calc(var(--spacing) * 3)",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
      "@media (width>=64rem)": "repeat(3,minmax(0,1fr))",
      "@media (width>=96rem)": "repeat(4,minmax(0,1fr))",
    },
  },
  agentsPageP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  cardShellDiv: {
    position: "absolute",
    top: "calc(var(--spacing) * 3)",
    right: "calc(var(--spacing) * 3)",
  },
  orchestratorCardDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 3)",
    paddingBottom: "calc(var(--spacing) * 3)",
  },
  orchestratorCardSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 20)",
    height: "calc(var(--spacing) * 20)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-hover)",
  },
  orchestratorCardSpan2: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  orchestratorCardSpan3: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  agentCardDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 3)",
  },
  agentCardSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 20)",
    height: "calc(var(--spacing) * 20)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-hover)",
  },
  agentCardSpan2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  agentCardSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  agentCardSpan4: {
    flexShrink: "0",
    borderRadius: ".25rem",
    backgroundColor: "var(--color-hat)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-bark-900)",
  },
  agentCardSpan5: {
    display: "flex",
    minWidth: "0",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    paddingTop: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  agentCardSpan6: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  agentCardDiv2: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
    paddingTop: "calc(var(--spacing) * 3)",
  },
  agentCardSpan7: {
    borderRadius: ".25rem",
    backgroundColor: "var(--color-hover)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  agentCardSpan8: {
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-ink)",
  },
  agentCardSpan9: {
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-ok-ink)",
  },
  agentCardSpan10: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textAlign: "right",
  },
  agentCardSpan11: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textAlign: "right",
    color: "var(--color-berry)",
  },
});

/** `rest` is the path after /agents/. */
export function AgentsRoute(props: { rest: string }) {
  return (
    <Show when={props.rest} keyed fallback={<AgentsPage />}>
      {(id) => (id === "templates" ? <TemplatesPage /> : <AgentPage id={decodeURIComponent(id)} />)}
    </Show>
  );
}

function AgentsPage() {
  const agents = useWorkAgents();
  const orchestrators = useOrchestrators();
  const core = useCore();
  const runtimes = useRuntimes();
  const allSkills = useSkills();
  const skills = createMemo(() => new Map(ready(allSkills, []).map((s) => [s.id, s.name])));
  const problems = useAgentProblems(agents);
  return (
    <div {...stylex.attrs(viewStyles.agentsPageDiv)}>
      <div {...stylex.attrs(viewStyles.agentsPageDiv2)}>
        <div {...stylex.attrs(viewStyles.agentsPageDiv3)}>
          <span {...stylex.attrs(viewStyles.agentsPageSpan)}>
            <A href="/agents/templates" data-testid="open-templates" title={t("web.agent.templates.openLine")} {...stylex.attrs(recipeStyles.agentsPageA)}>
              <Icon name="folder" size={14} />
              {t("web.agent.templates.open")}
            </A>
            <A href="/agents/new" data-testid="new-agent" {...stylex.attrs(recipeStyles.agentsPageA2)}>
              <Icon name="add" size={14} />
              {t("web.agent.list.make")}
            </A>
          </span>
        </div>
        <h2 {...stylex.attrs(viewStyles.agentsPageH2)}>{t("web.agent.list.orchestrators")}</h2>
        <div {...stylex.attrs(viewStyles.agentsPageDiv4)}>
          <For each={orchestrators()}>{(a) => <OrchestratorCard agent={a} />}</For>
          <A
            href="/agents/new?role=orchestrator"
            data-testid="new-orchestrator"
            aria-label={t("web.agent.list.makeOrchestrator")}
            {...stylex.attrs(recipeStyles.agentsPageA3)}
          >
            <Icon name="add" size={24} />
            {t("web.agent.list.makeOrchestrator")}
          </A>
        </div>
        <h2 {...stylex.attrs(viewStyles.agentsPageH2)}>{t("web.agent.list.helpers")}</h2>
        {/* The default orchestrator is always there: once it shows, the profiles are read. */}
        <Show when={orchestrators().length > 0 && agents().length === 0}>
          <p {...stylex.attrs(viewStyles.agentsPageP)}>
            <A href="/agents/templates" {...stylex.attrs(recipeStyles.agentsPageA4)}>
              {t("web.agent.templates.none")}
            </A>
          </p>
        </Show>
        <div {...stylex.attrs(viewStyles.agentsPageDiv4)}>
          <For each={agents()}>
            {(a) => (
              <AgentCard
                agent={a}
                runtime={ready(runtimes, []).find((r) => r.id === a.runtime)}
                tally={core()?.progress?.agents[a.id]}
                here={(core()?.sessions ?? []).filter((h) => h.agent === a.id).length}
                skillName={skills()}
                errors={(problems()[a.id] ?? []).filter((i) => i.level === "error").map((i) => i.text)}
              />
            )}
          </For>
          <A href="/agents/new" aria-label={t("web.agent.list.make")} {...stylex.attrs(recipeStyles.agentsPageA5)}>
            <Icon name="add" size={24} />
            {t("web.agent.list.make")}
          </A>
        </div>
      </div>
    </div>
  );
}

function CardShell(props: { agent: Agent; to: string; label: string; muted?: boolean; corner?: JSX.Element; children: JSX.Element }) {
  return (
    <div
      data-testid="agent-card"
      data-key={props.agent.id}
      data-role={props.agent.role}
      data-muted={props.muted === true ? "" : undefined}
      class="group relative"
    >
      <A
        href={props.to}
        aria-label={props.label}
        {...stylex.attrs(recipeStyles2.cardShellA, !(props.muted !== true) ? recipeStyles2.cardShellAVariant1Case2 : recipeStyles2.cardShellAVariant1Case1)}
      >
        {props.children}
      </A>
      <Show when={props.corner}>
        <div {...stylex.attrs(viewStyles.cardShellDiv)}>{props.corner}</div>
      </Show>
    </div>
  );
}

function OrchestratorCard(props: { agent: Agent }) {
  const main = () => props.agent.id === defaultOrchestrator;
  return (
    <CardShell agent={props.agent} to={orchestratorHref(props.agent.id)} label={props.agent.name}>
      <div {...stylex.attrs(viewStyles.orchestratorCardDiv)}>
        <span {...stylex.attrs(viewStyles.orchestratorCardSpan)}>
          <OrchestratorFace size={68} agent={props.agent.id} />
        </span>
        <span {...stylex.attrs(viewStyles.orchestratorCardSpan2)}>
          <span {...stylex.attrs(viewStyles.orchestratorCardSpan3)}>{props.agent.name}</span>
          <span {...stylex.attrs(variantStyles2.orchestratorCardSpan)}>{props.agent.duty || t("web.agent.list.orchestratorLine")}</span>
        </span>
      </div>
      <div {...stylex.attrs(recipeStyles.orchestratorCardDiv)}>
        <span>{t("web.agent.tab.memory")}</span>
        <span>{t("web.agent.list.ledger")}</span>
        <Show when={main()}>
          <span>{t("web.agent.list.voice")}</span>
        </Show>
      </div>
    </CardShell>
  );
}

export function AgentCard(props: {
  agent: Agent;
  runtime?: RuntimeInfo | undefined;
  tally?: AgentTally | undefined;
  here: number;
  skillName: Map<string, string>;
  errors: string[];
}) {
  const client = useQueryClient();
  const available = () => props.runtime?.installation.status === "available";
  const act = createAct();
  // The API saves a whole profile, and the cached one may be older than an edit made since (in another window).
  const toggle = () => {
    const { id, enabled } = props.agent;
    return act.run(async () => {
      const latest = (await api.agent.list()).find((a) => a.id === id);
      if (latest) await api.agent.update({ ...latest, enabled: !enabled });
      await client.invalidate({ prefix: ["agents"] });
    });
  };
  return (
    <CardShell
      agent={props.agent}
      to={`/agents/${encodeURIComponent(props.agent.id)}`}
      label={props.agent.name}
      muted={!props.agent.enabled}
      corner={
        <button
          type="button"
          data-testid="toggle"
          data-state={props.agent.enabled ? "on" : "off"}
          disabled={act.busy()}
          aria-busy={act.busy() ? "true" : undefined}
          onClick={() => void toggle()}
          aria-label={t("web.agent.list.toggle", {
            act: props.agent.enabled ? t("web.agent.list.disable") : t("web.agent.list.enable"),
            name: props.agent.name,
          })}
          class="cursor-pointer rounded-md border border-line bg-page px-2 py-0.5 text-xs font-medium text-muted opacity-0 group-hover:opacity-100 hover:bg-side hover:text-ink focus-visible:opacity-100"
        >
          {props.agent.enabled ? t("web.agent.list.disable") : t("web.agent.list.enable")}
        </button>
      }
    >
      <div {...stylex.attrs(viewStyles.agentCardDiv)}>
        <span
          {...stylex.attrs(viewStyles.agentCardSpan)}
          style={{ background: `radial-gradient(70% 70% at 50% 70%, ${hexColor(props.agent.look.hat)}33, transparent), var(--color-hover)` }}
        >
          <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={68} muted={!props.agent.enabled} />
        </span>
        <span {...stylex.attrs(viewStyles.orchestratorCardSpan2)}>
          <span {...stylex.attrs(viewStyles.agentCardSpan2)}>
            <span {...stylex.attrs(viewStyles.agentCardSpan3)}>{props.agent.name}</span>
            <Show when={props.here > 0}>
              <span {...stylex.attrs(viewStyles.agentCardSpan4)}>{t("web.agent.list.here", { n: props.here })}</span>
            </Show>
          </span>
          <span {...stylex.attrs(variantStyles2.orchestratorCardSpan)}>{props.agent.duty}</span>
          <span {...stylex.attrs(viewStyles.agentCardSpan5)}>
            <span
              {...stylex.attrs(variantStyles.agentCardSpan, available() ? variantStyles.agentCardSpanVariant : variantStyles.agentCardSpanVariant2)}
              aria-hidden="true"
            />
            <span {...stylex.attrs(viewStyles.agentCardSpan6)}>
              {[props.runtime?.preset.label ?? props.agent.runtime, props.agent.model, props.agent.effort].filter(Boolean).join(" · ")}
            </span>
          </span>
        </span>
      </div>
      <Show when={props.agent.skills.length > 0}>
        <div {...stylex.attrs(viewStyles.agentCardDiv2)}>
          <For each={props.agent.skills}>{(id) => <span {...stylex.attrs(viewStyles.agentCardSpan7)}>{props.skillName.get(id) ?? id}</span>}</For>
        </div>
      </Show>
      <div {...stylex.attrs(recipeStyles.orchestratorCardDiv)}>
        <span title={t("web.agent.list.tallyHint")}>
          {t("web.agent.list.hired")} <span {...stylex.attrs(viewStyles.agentCardSpan8)}>{Math.round(props.tally?.hired ?? 0)}</span>
        </span>
        <span>
          {t("web.agent.list.merged")} <span {...stylex.attrs(viewStyles.agentCardSpan9)}>{Math.round(props.tally?.harvested ?? 0)}</span>
        </span>
        <Show when={props.errors.length > 0} fallback={<span {...stylex.attrs(viewStyles.agentCardSpan10)}>{props.agent.tags.slice(0, 4).join(" · ")}</span>}>
          <span {...stylex.attrs(viewStyles.agentCardSpan11)} title={props.errors.join("\n")}>
            {t("web.agent.cannot")}
            {props.errors[0]}
          </span>
        </Show>
      </div>
    </CardShell>
  );
}
