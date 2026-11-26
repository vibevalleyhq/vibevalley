import { computed, effect, keymap, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, type AgentProblem, type RuntimeInfo, sessionAppendSystemPrompt } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { type Pose, randomLook, stagePoses } from "../../design/domain/cast";
import { OpenTerminal } from "../../design/domain/OpenTerminal";
import { runtimeName } from "../../design/domain/RuntimeBadge";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { MoreMenu } from "../../design/MoreMenu";
import { TextLink } from "../../design/TextLink";
import { useAgentProblems } from "../../infra/agents";
import { api, reasonOf } from "../../infra/api";
import { agentsQuery, ready, useAgents, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A, useRouter, useSearch } from "../../infra/router";
import { untrack } from "../../infra/solid";
import { runsHref } from "../session";
import { ConfigTabs, supportOf } from "./AgentConfig";
import { LookPanel, Stage } from "./AgentLook";
import { FromTemplate } from "./FromTemplate";
import { newOrchestrator, OrchestratorProfile } from "./OrchestratorProfile";
import { localizeAgentProblem } from "./readiness";

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

function Note(props: { children: string; testID?: string }) {
  return (
    <Text testID={props.testID} class="p-8 text-sm text-muted">
      {props.children}
    </Text>
  );
}

/** Built again for each id (Keyed by the route). */
export function AgentPage(props: { id: string }) {
  const isNew = () => props.id === "new";
  const search = useSearch();
  const agents = useAgents();
  const runtimes = useRuntimes();
  const loaded = computed(() => ready(agents, undefined));
  const saved = computed(() => loaded()?.find((a) => a.id === props.id));
  const role = computed(() => saved()?.role ?? (search().get("role") === "orchestrator" ? "orchestrator" : "worker"));
  return (
    <If when={!agents.error()} else={<Note>{t("web.agent.noProfiles") + reasonOf(agents.error())}</Note>}>
      <If
        when={loaded() && !(isNew() && !ready(runtimes, undefined))}
        else={<Note>{isNew() && runtimes.error() ? t("web.agent.noRuntimes", { why: reasonOf(runtimes.error()) }) : t("web.agent.loading")}</Note>}
      >
        <If
          when={isNew() || saved()}
          else={
            <View testID="agent-missing" class="flex-row flex-wrap p-8">
              <Text class="text-sm text-muted">{t("web.agent.noSuch")}</Text>
              <A href="/agents">
                <Text class="text-sm text-muted underline">{t("web.agent.backToAll")}</Text>
              </A>
            </View>
          }
        >
          <If
            when={role() === "orchestrator"}
            else={
              <Creator
                saved={saved()}
                start={untrack(() => saved() ?? newAgent(search().get("runtime") ?? "claude", ready(runtimes, [])))}
                all={loaded() ?? []}
              />
            }
          >
            <OrchestratorProfile saved={saved()} start={untrack(() => saved() ?? newOrchestrator())} all={loaded() ?? []} />
          </If>
        </If>
      </If>
    </If>
  );
}

function Creator(props: { saved?: Agent | undefined; start: Agent; all: readonly Agent[] }) {
  // A new one stays new until it is saved and the route moves to its id, which builds the page again.
  const isNew = untrack(() => !props.saved);
  const draft = signal(untrack(() => props.start));
  const pose = signal<Pose>("idle");
  const asking = signal(false);
  const saving = createAct();
  const talking = createAct();
  const removing = createAct();
  const router = useRouter();
  const client = useQueryClient();
  const runtimes = useRuntimes();
  const runtime = computed(() => ready(runtimes, []).find((r) => r.id === draft().runtime));
  const allProblems = useAgentProblems(() => [draft()]);
  const problems = computed(() => allProblems()[draft().id] ?? []);
  const dirty = computed(() => isNew || !same(props.saved, draft()));
  const nameTaken = computed(() => props.all.some((a) => a.id !== draft().id && a.name === draft().name.trim()));

  effect(() => {
    if (!asking()) return;
    return keymap.bind("escape", () => asking.set(false), { when: "always" });
  });

  const save = () => {
    const d = draft();
    const body = { ...d, name: d.name.trim() || t("web.agent.unnamedAgent") };
    return saving.run(async () => {
      const got = isNew ? await api.agent.create(body) : await api.agent.update(body);
      client.setData(agentsQuery(), (record) => (record ? { value: [...record.value.filter((a) => a.id !== got.id), got] } : undefined));
      await client.invalidate({ prefix: ["agents"] });
      draft.set(got);
      if (isNew) router.navigate(`/agents/${encodeURIComponent(got.id)}`);
    });
  };

  const remove = (id: string) =>
    removing.run(async () => {
      await api.agent.delete({ id });
      await client.invalidate({ prefix: ["agents"] });
      router.navigate("/agents");
    });

  const bar = () => (
    <View testID="profile-bar" desktop={{ windowDrag: true }} class="flex-row flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-line py-3">
      <A
        href="/agents"
        testID="back"
        class="group flex-row items-center gap-1 rounded-md px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
      >
        <Icon name="back" size={14} tone="muted" />
        <Text class="text-sm text-muted group-hover:text-ink">{t("web.agent.all")}</Text>
      </A>
      <Text class="text-sm text-faint">/</Text>
      <View class="min-w-0 flex-1 flex-row items-center gap-2.5">
        <Text class="truncate text-lg font-semibold text-ink">{draft().name || t("web.agent.unnamed")}</Text>
        <View
          testID={`profile-${isNew ? "new" : dirty() ? "dirty" : "saved"}`}
          class={`shrink-0 rounded-sm px-1.5 py-0.5 ${isNew || dirty() ? "bg-warn-soft" : "bg-hover"}`}
        >
          <Text class={`text-xs font-medium ${isNew || dirty() ? "text-warn-ink" : "text-muted"}`}>
            {isNew ? t("web.agent.isNew") : dirty() ? t("web.agent.unsaved") : t("web.agent.saved")}
          </Text>
        </View>
        <If when={draft().workdir.startsWith("/") ? draft().workdir : undefined}>{(cwd) => <OpenTerminal cwd={cwd()} title={draft().name} />}</If>
      </View>
      <View class="flex-row flex-wrap items-center gap-1.5">
        <If when={props.saved}>
          {(saved) => (
            <>
              <IconButton
                icon="log"
                label={t("web.agent.runsLink")}
                testid="agent-runs-link"
                onClick={() => router.navigate(runsHref({ agent: saved().id }))}
              />
              <IconButton
                icon="thread"
                label={t("web.agent.talk")}
                testid="talk"
                disabled={talking.busy()}
                onClick={() => {
                  const agent = saved().id;
                  void talking.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
                }}
              />
              <MoreMenu
                label={t("web.artifact.page.more")}
                testid="agent-more"
                items={[{ key: "delete", label: t("web.agent.remove"), icon: "delete", danger: true, onSelect: () => asking.set(true) }]}
              />
              <If when={dirty()}>
                <Button tone="quiet" testID="discard" onPress={() => draft.set(saved())}>
                  {t("web.agent.discard")}
                </Button>
              </If>
            </>
          )}
        </If>
        <Button tone="primary" testID="save" disabled={!dirty() || saving.busy() || nameTaken()} onPress={() => void save()}>
          {saving.busy() ? t("web.agent.saving") : isNew ? t("web.agent.create") : t("web.agent.save")}
        </Button>
      </View>
    </View>
  );

  return (
    <View testID="agent-page" class="h-full min-h-0 flex-1 bg-page px-4 pb-4">
      {bar()}
      <If when={asking() ? props.saved : undefined}>
        {(saved) => (
          <View testID="agent-delete" class="mt-2 shrink-0 flex-row flex-wrap items-center gap-2 rounded-md border border-line bg-bad-soft px-3 py-2">
            <Text class="min-w-0 flex-1 text-sm text-berry">{t("web.agent.removeWhich", { name: saved().name })}</Text>
            <Button tone="danger" icon="delete" testID="delete-sure" disabled={removing.busy()} onPress={() => void remove(saved().id)}>
              {t("web.agent.remove")}
            </Button>
            <Button onPress={() => asking.set(false)}>{t("web.base.form.never")}</Button>
          </View>
        )}
      </If>
      <If when={props.saved}>{(saved) => <FromTemplate agent={saved()} onUpdated={(a) => draft.set(a)} />}</If>
      <Scroll class="min-h-0 flex-1" contentClass="min-h-full gap-3 pt-3 lg:flex-row">
        <View class="shrink-0 rounded-lg border border-line bg-page p-4 lg:w-84">
          <LookPanel draft={draft()} onChange={(look) => draft.set({ ...draft(), look })} />
        </View>
        <View class="min-h-104 flex-1 overflow-hidden rounded-lg border border-line bg-page">
          <Stage draft={draft()} pose={pose()} />
          <View class="flex-row flex-wrap justify-center gap-1.5 p-3">
            <Each of={stagePoses}>
              {(p) => (
                <View
                  role="button"
                  accessibilityState={{ selected: pose() === p().pose }}
                  onPress={() => pose.set(p().pose)}
                  class={`h-6 justify-center rounded-full px-2.5 ${pose() === p().pose ? "bg-ink" : "bg-hover hover:bg-selected"}`}
                >
                  <Text class={`text-xs font-medium ${pose() === p().pose ? "text-page" : "text-ink"}`}>{p().label}</Text>
                </View>
              )}
            </Each>
          </View>
        </View>
        <View class="min-h-120 shrink-0 overflow-hidden rounded-lg border border-line bg-page lg:w-108">
          <ConfigTabs draft={draft()} runtime={runtime()} patch={(a) => draft.set(a)} nameTaken={nameTaken()} isNew={isNew} />
          <Problems problems={problems()} />
        </View>
      </Scroll>
    </View>
  );
}

function Problems(props: { problems: AgentProblem[] }) {
  return (
    <If
      when={props.problems.length > 0}
      else={
        <View testID="agent-fine" class="flex-row items-center gap-1.5 border-t border-line px-4 py-3">
          <Icon name="check" size={12} />
          <Text class="text-sm text-ok-ink">{t("web.agent.fine")}</Text>
        </View>
      }
    >
      <Scroll accessibilityLabel={t("web.agent.problems")} testID="agent-problems" class="max-h-40 border-t border-line" contentClass="gap-1 px-4 py-3">
        <Each of={props.problems} key={(p) => `${p.level}:${p.text}`}>
          {(i) => {
            const localized = () => localizeAgentProblem(i().text);
            return (
              <View class="flex-row items-start gap-1.5">
                <View class="mt-1">
                  <Icon name={i().level === "error" ? "cross" : "warn"} size={12} />
                </View>
                <Text class={`min-w-0 flex-1 text-sm ${i().level === "error" ? "text-berry" : "text-warn-ink"}`}>
                  {(i().level === "error" ? t("web.agent.cannot") : "") + localized().text}
                </Text>
                <If when={localized().fixHref}>
                  {(href) => (
                    <TextLink href={href()} testid="agent-problem-fix" danger={i().level === "error"}>
                      {t("web.setting.readiness.fix")}
                    </TextLink>
                  )}
                </If>
              </View>
            );
          }}
        </Each>
      </Scroll>
    </If>
  );
}
