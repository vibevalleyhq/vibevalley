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
import { styleProps } from "#/ui/positioner.ts";

import { AgentPage } from "./AgentPage";
import { TemplatesPage } from "./TemplatesPage";

const cardStyles = stylex.create({
  portrait: (hat: string) => ({ backgroundImage: `radial-gradient(70% 70% at 50% 70%, ${hat}33, transparent)`, backgroundColor: "var(--color-hover)" }),
  card: {
    position: "relative",
  },
  toggle: {
    cursor: "pointer",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: {
      default: "var(--wb-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-side)",
      },
    },
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
    opacity: {
      default: "0",
      ":focus-visible": "1",
      "@media (hover: hover)": {
        default: null,
        [stylex.when.ancestor(":hover")]: 1,
      },
    },
  },
});

const styles = stylex.create({
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
    padding: "1rem",
    transitionProperty: "color, background-color, border-color",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "180ms",
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
  cardShellAPrimary: {
    borderStyle: "solid",
  },
  cardShellASecondary: {
    borderStyle: "dashed",
  },
  agentsPageA: {
    display: "inline-flex",
    height: "1.75rem",
    alignItems: "center",
    gap: "0.375rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "0.625rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
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
    height: "1.75rem",
    alignItems: "center",
    gap: "0.375rem",
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
    paddingInline: "0.625rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-page)",
  },
  agentsPageA3: {
    display: "flex",
    minHeight: "8rem",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
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
    lineHeight: "var(--leading-sm)",
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
    minHeight: "11rem",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
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
    lineHeight: "var(--leading-sm)",
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
    gap: "0.75rem",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingTop: "0.75rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  orchestratorCardSpan: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  agentCardSpan: {
    width: "7px",
    height: "7px",
    flexShrink: "0",
    borderRadius: "9999px",
  },
  agentCardSpanTone: {
    backgroundColor: "var(--color-leaf)",
  },
  agentCardSpanAlt: {
    backgroundColor: "var(--color-berry)",
  },
  agentsPageDiv: {
    height: "100%",
    overflowY: "auto",
  },
  agentsPageDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "1.5rem",
    paddingInline: "1rem",
    paddingTop: "1rem",
    paddingBottom: "2rem",
  },
  agentsPageDiv3: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "flex-end",
    gap: "0.75rem",
  },
  agentsPageSpan: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  agentsPageH2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  agentsPageDiv4: {
    display: "grid",
    gap: "0.75rem",
    gridTemplateColumns: {
      default: null,
      "@media (width>=40rem)": "repeat(2,minmax(0,1fr))",
      "@media (width>=64rem)": "repeat(3,minmax(0,1fr))",
      "@media (width>=96rem)": "repeat(4,minmax(0,1fr))",
    },
  },
  agentsPageP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  cardShellDiv: {
    position: "absolute",
    top: "0.75rem",
    right: "0.75rem",
  },
  orchestratorCardDiv2: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
    paddingBottom: "0.75rem",
  },
  orchestratorCardSpan2: {
    display: "flex",
    width: "5rem",
    height: "5rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-hover)",
  },
  orchestratorCardSpan22: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
    gap: "0.125rem",
  },
  orchestratorCardSpan3: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    fontWeight: "var(--font-weight-semibold)",
  },
  agentCardDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
  },
  agentCardSpan2: {
    display: "flex",
    width: "5rem",
    height: "5rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-hover)",
  },
  agentCardSpan22: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  agentCardSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    fontWeight: "var(--font-weight-semibold)",
  },
  agentCardSpan4: {
    flexShrink: "0",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-hat)",
    paddingInline: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-bark-900)",
  },
  agentCardSpan5: {
    display: "flex",
    minWidth: "0",
    alignItems: "center",
    gap: "0.375rem",
    paddingTop: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
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
    gap: "0.25rem",
    paddingTop: "0.75rem",
  },
  agentCardSpan7: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
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
    <div {...stylex.attrs(styles.agentsPageDiv)}>
      <div {...stylex.attrs(styles.agentsPageDiv2)}>
        <div {...stylex.attrs(styles.agentsPageDiv3)}>
          <span {...stylex.attrs(styles.agentsPageSpan)}>
            <A href="/agents/templates" data-testid="open-templates" title={t("web.agent.templates.openLine")} {...stylex.attrs(styles.agentsPageA)}>
              <Icon name="folder" size={14} />
              {t("web.agent.templates.open")}
            </A>
            <A href="/agents/new" data-testid="new-agent" {...stylex.attrs(styles.agentsPageA2)}>
              <Icon name="add" size={14} />
              {t("web.agent.list.make")}
            </A>
          </span>
        </div>
        <h2 {...stylex.attrs(styles.agentsPageH2)}>{t("web.agent.list.orchestrators")}</h2>
        <div {...stylex.attrs(styles.agentsPageDiv4)}>
          <For each={orchestrators()}>{(a) => <OrchestratorCard agent={a} />}</For>
          <A
            href="/agents/new?role=orchestrator"
            data-testid="new-orchestrator"
            aria-label={t("web.agent.list.makeOrchestrator")}
            {...stylex.attrs(styles.agentsPageA3)}
          >
            <Icon name="add" size={24} />
            {t("web.agent.list.makeOrchestrator")}
          </A>
        </div>
        <h2 {...stylex.attrs(styles.agentsPageH2)}>{t("web.agent.list.helpers")}</h2>
        {/* The default orchestrator is always there: once it shows, the profiles are read. */}
        <Show when={orchestrators().length > 0 && agents().length === 0}>
          <p {...stylex.attrs(styles.agentsPageP)}>
            <A href="/agents/templates" {...stylex.attrs(styles.agentsPageA4)}>
              {t("web.agent.templates.none")}
            </A>
          </p>
        </Show>
        <div {...stylex.attrs(styles.agentsPageDiv4)}>
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
          <A href="/agents/new" aria-label={t("web.agent.list.make")} {...stylex.attrs(styles.agentsPageA5)}>
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
      {...styleProps([stylex.defaultMarker(), cardStyles.card])}
    >
      <A
        href={props.to}
        aria-label={props.label}
        {...stylex.attrs(styles.cardShellA, !(props.muted !== true) ? styles.cardShellASecondary : styles.cardShellAPrimary)}
      >
        {props.children}
      </A>
      <Show when={props.corner}>
        <div {...stylex.attrs(styles.cardShellDiv)}>{props.corner}</div>
      </Show>
    </div>
  );
}

function OrchestratorCard(props: { agent: Agent }) {
  const main = () => props.agent.id === defaultOrchestrator;
  return (
    <CardShell agent={props.agent} to={orchestratorHref(props.agent.id)} label={props.agent.name}>
      <div {...stylex.attrs(styles.orchestratorCardDiv2)}>
        <span {...stylex.attrs(styles.orchestratorCardSpan2)}>
          <OrchestratorFace size={68} agent={props.agent.id} />
        </span>
        <span {...stylex.attrs(styles.orchestratorCardSpan22)}>
          <span {...stylex.attrs(styles.orchestratorCardSpan3)}>{props.agent.name}</span>
          <span {...stylex.attrs(styles.orchestratorCardSpan)}>{props.agent.duty || t("web.agent.list.orchestratorLine")}</span>
        </span>
      </div>
      <div {...stylex.attrs(styles.orchestratorCardDiv)}>
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
          {...styleProps(cardStyles.toggle)}
        >
          {props.agent.enabled ? t("web.agent.list.disable") : t("web.agent.list.enable")}
        </button>
      }
    >
      <div {...stylex.attrs(styles.agentCardDiv)}>
        <span {...styleProps([styles.agentCardSpan2, cardStyles.portrait(hexColor(props.agent.look.hat))])}>
          <AgentFace agentId={props.agent.id} runtime={props.agent.runtime} look={props.agent.look} size={68} muted={!props.agent.enabled} />
        </span>
        <span {...stylex.attrs(styles.orchestratorCardSpan22)}>
          <span {...stylex.attrs(styles.agentCardSpan22)}>
            <span {...stylex.attrs(styles.agentCardSpan3)}>{props.agent.name}</span>
            <Show when={props.here > 0}>
              <span {...stylex.attrs(styles.agentCardSpan4)}>{t("web.agent.list.here", { n: props.here })}</span>
            </Show>
          </span>
          <span {...stylex.attrs(styles.orchestratorCardSpan)}>{props.agent.duty}</span>
          <span {...stylex.attrs(styles.agentCardSpan5)}>
            <span
              {...stylex.attrs(styles.agentCardSpan, available() ? styles.agentCardSpanTone : styles.agentCardSpanAlt)}
              aria-hidden="true"
            />
            <span {...stylex.attrs(styles.agentCardSpan6)}>
              {[props.runtime?.preset.label ?? props.agent.runtime, props.agent.model, props.agent.effort].filter(Boolean).join(" · ")}
            </span>
          </span>
        </span>
      </div>
      <Show when={props.agent.skills.length > 0}>
        <div {...stylex.attrs(styles.agentCardDiv2)}>
          <For each={props.agent.skills}>{(id) => <span {...stylex.attrs(styles.agentCardSpan7)}>{props.skillName.get(id) ?? id}</span>}</For>
        </div>
      </Show>
      <div {...stylex.attrs(styles.orchestratorCardDiv)}>
        <span title={t("web.agent.list.tallyHint")}>
          {t("web.agent.list.hired")} <span {...stylex.attrs(styles.agentCardSpan8)}>{Math.round(props.tally?.hired ?? 0)}</span>
        </span>
        <span>
          {t("web.agent.list.merged")} <span {...stylex.attrs(styles.agentCardSpan9)}>{Math.round(props.tally?.harvested ?? 0)}</span>
        </span>
        <Show when={props.errors.length > 0} fallback={<span {...stylex.attrs(styles.agentCardSpan10)}>{props.agent.tags.slice(0, 4).join(" · ")}</span>}>
          <span {...stylex.attrs(styles.agentCardSpan11)} title={props.errors.join("\n")}>
            {t("web.agent.cannot")}
            {props.errors[0]}
          </span>
        </Show>
      </div>
    </CardShell>
  );
}
