import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Agent, type AgentProblem, type RuntimeInfo, sessionAppendSystemPrompt } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { aria } from "#/base/dom.tsx";
import { TrajectoryList } from "#/features/session/index.ts";
import { useAgentProblems } from "#/infra/agents.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { agentsQuery, useQueryClient, ready, useAgents, useRuntimes } from "#/infra/query.ts";
import { useRouter, useSearch, Link as A } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { type Pose, randomLook, stagePoses } from "#/ui/cast.ts";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { runtimeName } from "#/ui/RuntimeBadge.tsx";

import { ConfigTabs, supportOf } from "./AgentConfig";
import { LookPanel, Stage } from "./AgentLook";
import { FromTemplate } from "./FromTemplate";
import { newOrchestrator, OrchestratorProfile } from "./OrchestratorProfile";

const styles = stylex.create({
  creatorDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: {
      default: "column",
      "@media (width>=64rem)": "row",
    },
    gap: "0.75rem",
    overflowY: {
      default: "auto",
      "@media (width>=64rem)": "hidden",
    },
    paddingTop: "0.75rem",
    overflowX: {
      default: null,
      "@media (width>=64rem)": "hidden",
    },
  },
  problemsIcon: {
    marginTop: "0.25rem",
  },
  agentPageA: {
    textDecorationLine: "underline",
  },
  creatorA: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  creatorSpan: {
    flexShrink: "0",
    borderRadius: "var(--radius-sm)",
    paddingInline: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  creatorSpanTone: {
    backgroundColor: "var(--color-hat)",
    color: "var(--color-bark-900)",
  },
  creatorSpanAlt: {
    backgroundColor: "var(--color-hover)",
    color: "var(--color-muted)",
  },
  creatorDiv2: {
    display: "flex",
    minHeight: "26rem",
    flex: "1",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
  },
  creatorButton: {
    height: "1.5rem",
    cursor: "pointer",
    borderRadius: "9999px",
    paddingInline: "0.625rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  creatorButtonTone: {
    backgroundColor: "var(--color-ink)",
    color: "var(--color-page)",
  },
  creatorButtonAlt: {
    backgroundColor: {
      default: "var(--color-hover)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-selected)",
      },
    },
  },
  problemsLi: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.375rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  problemsLiTone: {
    color: "var(--color-berry)",
  },
  problemsLiAlt: {
    color: "var(--color-warn-ink)",
  },
  agentPageP: {
    padding: "2rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  profileBar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "0.75rem",
    rowGap: "0.5rem",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingBlock: "0.75rem",
  },
  barSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-faint)",
  },
  barSpan2: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    alignItems: "center",
    gap: "0.75rem",
  },
  barSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--leading-lg)",
    fontWeight: "var(--font-weight-semibold)",
  },
  barSpan4: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  creatorDiv3: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: "column",
    gap: "0.75rem",
    paddingInline: "1rem",
    paddingBottom: "1rem",
  },
  creatorDiv22: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  creatorButton2: {
    cursor: "pointer",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  creatorSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  creatorDiv32: {
    minHeight: "0",
    flex: "1",
  },
  creatorDiv4: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: "column",
    paddingInline: "1rem",
    paddingBottom: "1rem",
  },
  creatorDiv5: {
    flexShrink: "0",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "1rem",
    width: {
      default: null,
      "@media (width>=64rem)": "19rem",
    },
    overflowY: {
      default: null,
      "@media (width>=64rem)": "auto",
    },
  },
  creatorDiv6: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "0.375rem",
    padding: "0.75rem",
  },
  creatorDiv7: {
    display: "flex",
    flexShrink: "0",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    width: {
      default: null,
      "@media (width>=64rem)": "27rem",
    },
  },
  problemsP: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "1rem",
    paddingBlock: "0.75rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-ok-ink)",
  },
  problemsUl: {
    display: "flex",
    maxHeight: "10rem",
    flexDirection: "column",
    gap: "0.25rem",
    overflowY: "auto",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "1rem",
    paddingBlock: "0.75rem",
  },
});

function newAgent(runtime: string, catalog: readonly RuntimeInfo[]): Agent {
  const info = catalog.find((r) => r.id === runtime);
  return {
    id: "",
    name: t("web.agent.newName", { runtime: runtimeName(catalog, runtime) }),
    role: "worker",
    duty: "",
    enabled: true,
    runtime,
    model: "",
    effort: "",
    persona: "",
    personaMode: supportOf(info).refused[sessionAppendSystemPrompt] ? "prompt" : "append",
    skills: [],
    mcpServers: [],
    disallowedTools: [],
    env: {},
    workdir: "",
    worktree: true,
    tags: [],
    look: { ...randomLook(), outfit: "farmer" },
  };
}

/** Built again for each id (Keyed by the route). */
export function AgentPage(props: { id: string }) {
  const isNew = () => props.id === "new";
  const search = useSearch();
  const agents = useAgents();
  const runtimes = useRuntimes();
  const loaded = () => ready(agents, undefined);
  const saved = () => loaded()?.find((a) => a.id === props.id);
  return (
    <Switch>
      <Match when={agents.error()}>
        {(e) => (
          <p {...stylex.attrs(styles.agentPageP)}>
            {t("web.agent.noProfiles")}
            {reasonOf(e())}
          </p>
        )}
      </Match>
      <Match when={!loaded() || (isNew() && !ready(runtimes, undefined))}>
        <p {...stylex.attrs(styles.agentPageP)}>
          {isNew() && runtimes.error() ? t("web.agent.noRuntimes", { why: reasonOf(runtimes.error()) }) : t("web.agent.loading")}
        </p>
      </Match>
      <Match when={!isNew() && !saved()}>
        <p data-testid="agent-missing" {...stylex.attrs(styles.agentPageP)}>
          {t("web.agent.noSuch")}
          <A href="/agents" {...stylex.attrs(styles.agentPageA)}>
            {t("web.agent.backToAll")}
          </A>
        </p>
      </Match>
      <Match when={(saved()?.role ?? (search().get("role") === "orchestrator" ? "orchestrator" : "worker")) === "orchestrator" && loaded()}>
        {(all) => <OrchestratorProfile saved={saved()} start={untrack(() => saved() ?? newOrchestrator())} all={all()} />}
      </Match>
      <Match when={loaded()}>
        {(all) => <Creator saved={saved()} start={untrack(() => saved() ?? newAgent(search().get("runtime") ?? "claude", ready(runtimes, [])))} all={all()} />}
      </Match>
    </Switch>
  );
}

function Creator(props: { saved?: Agent | undefined; start: Agent; all: readonly Agent[] }) {
  // A new one stays new until it is saved and the route moves to its id, which builds the page again.
  const isNew = untrack(() => !props.saved);
  const [draft, setDraft] = createSignal(untrack(() => props.start));
  const [pose, setPose] = createSignal<Pose>("idle");
  const saving = createAct();
  const talking = createAct();
  const [trajectories, setTrajectories] = createSignal(false);
  const router = useRouter();
  const client = useQueryClient();
  const runtimes = useRuntimes();
  const runtime = () => ready(runtimes, []).find((r) => r.id === draft().runtime);
  const allProblems = useAgentProblems(() => [draft()]);
  const problems = () => allProblems()[draft().id] ?? [];
  const dirty = () => isNew || !same(props.saved, draft());
  const nameTaken = () => props.all.some((a) => a.id !== draft().id && a.name === draft().name.trim());

  const save = () => {
    const d = draft();
    const body = { ...d, name: d.name.trim() || t("web.agent.unnamedAgent") };
    return saving.run(async () => {
      const got = isNew ? await api.agent.create(body) : await api.agent.update(body);
      client.setData(agentsQuery(), (record) => (record ? { value: [...record.value.filter((a) => a.id !== got.id), got] } : undefined));
      await client.invalidate({ prefix: ["agents"] });
      setDraft(got);
      if (isNew) router.navigate(`/agents/${encodeURIComponent(got.id)}`);
    });
  };

  const bar = () => (
    <div data-testid="profile-bar" data-state={isNew ? "new" : dirty() ? "dirty" : "saved"} {...stylex.attrs(styles.profileBar)}>
      <A href="/agents" data-testid="back" {...stylex.attrs(styles.creatorA)}>
        {t("web.agent.all")}
      </A>
      <span {...stylex.attrs(styles.barSpan)}>/</span>
      <span {...stylex.attrs(styles.barSpan2)}>
        <span {...stylex.attrs(styles.barSpan3)}>{draft().name || t("web.agent.unnamed")}</span>
        <span {...stylex.attrs(styles.creatorSpan, isNew || dirty() ? styles.creatorSpanTone : styles.creatorSpanAlt)}>
          {isNew ? t("web.agent.isNew") : dirty() ? t("web.agent.unsaved") : t("web.agent.saved")}
        </span>
      </span>
      <span {...stylex.attrs(styles.barSpan4)}>
        <Show when={props.saved}>
          {(saved) => (
            <>
              <DeleteButton agent={saved()} />
              <Button
                icon="thread"
                data-testid="talk"
                disabled={talking.busy()}
                onClick={() => {
                  const agent = saved().id;
                  void talking.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
                }}
              >
                {t("web.agent.talk")}
              </Button>
              <Show when={dirty()}>
                <Button data-testid="discard" onClick={() => setDraft(saved())}>
                  {t("web.agent.discard")}
                </Button>
              </Show>
            </>
          )}
        </Show>
        <Button tone="primary" data-testid="save" disabled={!dirty() || saving.busy() || nameTaken()} onClick={() => void save()}>
          {saving.busy() ? t("web.agent.saving") : isNew ? t("web.agent.create") : t("web.agent.save")}
        </Button>
      </span>
    </div>
  );

  return (
    <Show
      when={!trajectories()}
      fallback={
        <div {...stylex.attrs(styles.creatorDiv3)}>
          {bar()}
          <div {...stylex.attrs(styles.creatorDiv22)}>
            <button type="button" {...stylex.attrs(styles.creatorButton2)} onClick={() => setTrajectories(false)}>
              {t("web.agent.backToProfile")}
            </button>
            <span {...stylex.attrs(styles.creatorSpan2)} title={t("web.agent.trajectoriesHint")}>
              {t("web.agent.trajectories")}
            </span>
          </div>
          <div {...stylex.attrs(styles.creatorDiv32)}>
            <TrajectoryList agent={draft().id} />
          </div>
        </div>
      }
    >
      <div {...stylex.attrs(styles.creatorDiv4)}>
        {bar()}
        <Show when={props.saved}>{(saved) => <FromTemplate agent={saved()} onUpdated={setDraft} />}</Show>
        <div {...stylex.attrs(styles.creatorDiv)}>
          <div {...stylex.attrs(styles.creatorDiv5)}>
            <LookPanel draft={draft()} onChange={(look) => setDraft({ ...draft(), look })} />
          </div>
          <div {...stylex.attrs(styles.creatorDiv2)}>
            <Stage draft={draft()} pose={pose()} />
            <div {...stylex.attrs(styles.creatorDiv6)}>
              <For each={stagePoses}>
                {(p) => (
                  <button
                    type="button"
                    aria-pressed={aria(pose() === p.pose)}
                    onClick={() => setPose(p.pose)}
                    {...stylex.attrs(styles.creatorButton, pose() === p.pose ? styles.creatorButtonTone : styles.creatorButtonAlt)}
                  >
                    {p.label}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div {...stylex.attrs(styles.creatorDiv7)}>
            <ConfigTabs
              draft={draft()}
              runtime={runtime()}
              patch={setDraft}
              nameTaken={nameTaken()}
              isNew={isNew}
              onTrajectories={() => setTrajectories(true)}
            />
            <Problems problems={problems()} />
          </div>
        </div>
      </div>
    </Show>
  );
}

function DeleteButton(props: { agent: Agent }) {
  const router = useRouter();
  const client = useQueryClient();
  const act = createAct();
  const remove = () => {
    const id = props.agent.id;
    return act.run(async () => {
      await api.agent.delete({ id });
      await client.invalidate({ prefix: ["agents"] });
      router.navigate("/agents");
    });
  };
  return <ConfirmButton label={t("web.agent.remove")} question={t("web.agent.removeWhich", { name: props.agent.name })} testid="delete" onConfirm={remove} />;
}

function Problems(props: { problems: AgentProblem[] }) {
  return (
    <Show
      when={props.problems.length > 0}
      fallback={
        <p {...stylex.attrs(styles.problemsP)}>
          <Icon name="check" size={12} />
          {t("web.agent.fine")}
        </p>
      }
    >
      <ul aria-label={t("web.agent.problems")} {...stylex.attrs(styles.problemsUl)}>
        <For each={props.problems}>
          {(i) => (
            <li {...stylex.attrs(styles.problemsLi, i.level === "error" ? styles.problemsLiTone : styles.problemsLiAlt)}>
              <Icon name={i.level === "error" ? "cross" : "warn"} size={12} styles={[styles.problemsIcon]} />
              {i.level === "error" ? t("web.agent.cannot") : ""}
              {i.text}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
