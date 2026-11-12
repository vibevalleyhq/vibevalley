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
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { type Pose, randomLook, stagePoses } from "#/ui/domain/cast.ts";
import { runtimeName } from "#/ui/domain/RuntimeBadge.tsx";
import { Icon } from "#/ui/Icon.tsx";

import { ConfigTabs, supportOf } from "./AgentConfig";
import { LookPanel, Stage } from "./AgentLook";
import { FromTemplate } from "./FromTemplate";
import { newOrchestrator, OrchestratorProfile } from "./OrchestratorProfile";

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
          <p class="p-8 text-sm text-muted">
            {t("web.agent.noProfiles")}
            {reasonOf(e())}
          </p>
        )}
      </Match>
      <Match when={!loaded() || (isNew() && !ready(runtimes, undefined))}>
        <p class="p-8 text-sm text-muted">
          {isNew() && runtimes.error() ? t("web.agent.noRuntimes", { why: reasonOf(runtimes.error()) }) : t("web.agent.loading")}
        </p>
      </Match>
      <Match when={!isNew() && !saved()}>
        <p data-testid="agent-missing" class="p-8 text-sm text-muted">
          {t("web.agent.noSuch")}
          <A href="/agents" class="underline">
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
    <div
      data-testid="profile-bar"
      data-state={isNew ? "new" : dirty() ? "dirty" : "saved"}
      class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line py-3"
    >
      <A href="/agents" data-testid="back" class="text-sm text-muted hover:underline">
        {t("web.agent.all")}
      </A>
      <span class="text-sm text-faint">/</span>
      <span class="flex min-w-0 flex-1 items-center gap-3">
        <span class="truncate text-lg font-semibold">{draft().name || t("web.agent.unnamed")}</span>
        <span class={["shrink-0 rounded-sm px-1.5 text-xs", isNew || dirty() ? "bg-hat text-bark-900" : "bg-hover text-muted"]}>
          {isNew ? t("web.agent.isNew") : dirty() ? t("web.agent.unsaved") : t("web.agent.saved")}
        </span>
      </span>
      <span class="flex flex-wrap items-center gap-2">
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
        <div class="flex h-full min-h-0 flex-col gap-3 px-4 pb-4">
          {bar()}
          <div class="flex items-center gap-3">
            <button type="button" class="cursor-pointer text-sm text-muted hover:underline" onClick={() => setTrajectories(false)}>
              {t("web.agent.backToProfile")}
            </button>
            <span class="text-sm font-semibold" title={t("web.agent.trajectoriesHint")}>
              {t("web.agent.trajectories")}
            </span>
          </div>
          <div class="min-h-0 flex-1">
            <TrajectoryList agent={draft().id} />
          </div>
        </div>
      }
    >
      <div class="flex h-full min-h-0 flex-col px-4 pb-4">
        {bar()}
        <Show when={props.saved}>{(saved) => <FromTemplate agent={saved()} onUpdated={setDraft} />}</Show>
        <div class="flex min-h-0 flex-1 flex-col lg:flex-row gap-3 overflow-y-auto lg:overflow-y-hidden pt-3 lg:overflow-x-hidden">
          <div class="shrink-0 rounded-lg border border-line bg-page p-4 lg:w-76 lg:overflow-y-auto">
            <LookPanel draft={draft()} onChange={(look) => setDraft({ ...draft(), look })} />
          </div>
          <div class="flex min-h-104 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-page">
            <Stage draft={draft()} pose={pose()} />
            <div class="flex flex-wrap justify-center gap-1.5 p-3">
              <For each={stagePoses}>
                {(p) => (
                  <button
                    type="button"
                    aria-pressed={aria(pose() === p.pose)}
                    onClick={() => setPose(p.pose)}
                    class={["h-6 cursor-pointer rounded-full px-2.5 text-xs", pose() === p.pose ? "bg-ink text-page" : "bg-hover hover:bg-selected"]}
                  >
                    {p.label}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="flex shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-page lg:w-108">
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
        <p class="flex items-center gap-1.5 border-t border-line px-4 py-3 text-sm text-ok-ink">
          <Icon name="check" size={12} />
          {t("web.agent.fine")}
        </p>
      }
    >
      <ul aria-label={t("web.agent.problems")} class="flex max-h-40 flex-col gap-1 overflow-y-auto border-t border-line px-4 py-3">
        <For each={props.problems}>
          {(i) => (
            <li class={["flex items-start gap-1.5 text-sm", i.level === "error" ? "text-berry" : "text-warn-ink"]}>
              <Icon name={i.level === "error" ? "cross" : "warn"} size={12} class="mt-1" />
              {i.level === "error" ? t("web.agent.cannot") : ""}
              {i.text}
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
