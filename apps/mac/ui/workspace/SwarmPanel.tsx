import { computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../design/Icon";
import { SkeletonLines, useDelayedBusy } from "../design/Skeleton";
import { Dot } from "../design/Tag";
import {
  fetchChildTranscript,
  formatTokens,
  parseBoardTokens,
  type SessionChildStep,
  type SessionSwarmMember,
  type SessionSwarmMemberState,
  type SessionSwarmMessage,
  type SessionSwarmOverview,
  type SessionSwarmState,
  type SessionSwarmThread,
} from "./chatSession";
import { ShellIconButton } from "./chrome";

type SwarmTab = "overview" | "roster" | "board";

function memberStateTone(state: SessionSwarmMemberState): "leaf" | "wheat" | "idle" | "berry" {
  switch (state) {
    case "working":
      return "leaf";
    case "waiting":
      return "wheat";
    case "stopped":
      return "idle";
    case "killed":
      return "berry";
  }
}

function memberStateLabel(member: SessionSwarmMember): string {
  switch (member.state) {
    case "working":
      return t("web.shell.swarm.stateWorking");
    case "waiting":
      if (member.waitSince !== undefined) {
        return member.wakeMode === "any"
          ? t("web.shell.swarm.stateWaitingAll", { seq: member.waitSince })
          : t("web.shell.swarm.stateWaitingMentions", { seq: member.waitSince });
      }
      return t("web.shell.swarm.stateWaiting");
    case "stopped":
      return t("web.shell.swarm.stateStopped");
    case "killed":
      return t("web.shell.swarm.stateKilled");
  }
}

function formatMessageTime(raw: string): string {
  const space = raw.indexOf(" ");
  if (space >= 0) return raw.slice(space + 1, space + 9);
  const tIdx = raw.indexOf("T");
  if (tIdx >= 0) return raw.slice(tIdx + 1, tIdx + 9);
  return raw;
}

function ThreadCard(props: {
  thread: SessionSwarmThread;
  overview: SessionSwarmOverview;
  memberMap: ReadonlyMap<string, SessionSwarmMember>;
  onSelectMember: (name: string) => void;
}) {
  return (
    <View testID={`swarm-thread-${props.thread.id}`} class="gap-1.5 rounded-lg border border-line bg-page p-2.5">
      <Text class="text-xs font-semibold text-ink">{props.thread.title}</Text>
      <If when={props.thread.goal}>{(goal) => <Text class="text-xs text-muted">{goal()}</Text>}</If>
      <If when={props.thread.members.length > 0}>
        <View class="gap-1 pt-0.5">
          <Each of={props.thread.members} key={(name) => name}>
            {(name) => {
              const member = () => props.memberMap.get(name());
              const blurb = () => props.overview.tasks[name()] ?? member()?.task;
              return (
                <View
                  role="button"
                  testID={`swarm-overview-member-${name()}`}
                  onPress={() => props.onSelectMember(name())}
                  class="flex-row items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <Dot tone={memberStateTone(member()?.state ?? "stopped")} size={6} ring={false} />
                  <Text class="shrink-0 font-mono text-2xs font-semibold text-ink">{name()}</Text>
                  <If when={blurb()}>{(txt) => <Text class="min-w-0 flex-1 truncate text-2xs text-muted">{txt()}</Text>}</If>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
    </View>
  );
}

function BoardToken(props: { item: ReturnType<typeof parseBoardTokens>[number] }) {
  const isStall = () => props.item.value === "[stall]";
  return (
    <If
      when={props.item.kind === "mention"}
      else={
        <If
          when={props.item.kind === "seq"}
          else={
            <If when={props.item.kind === "tag"} else={<Text class="text-xs text-ink select-text">{props.item.value}</Text>}>
              <View class={`rounded-sm px-1 py-px ${isStall() ? "bg-warn-soft" : "bg-ok-soft"}`}>
                <Text class={`font-mono text-2xs font-semibold ${isStall() ? "text-warn-ink" : "text-ok-ink"}`}>{props.item.value}</Text>
              </View>
            </If>
          }
        >
          <Text class="font-mono text-xs font-medium text-ink">{props.item.value}</Text>
        </If>
      }
    >
      <Text class="font-mono text-xs font-medium text-water">{props.item.value}</Text>
    </If>
  );
}

function BoardMessageBody(props: { text: string }) {
  const tokens = computed(() => parseBoardTokens(props.text));
  return (
    <View class="flex-row flex-wrap items-center gap-x-1 gap-y-0.5">
      <Each of={tokens()} key="index">
        {(tok) => <BoardToken item={tok()} />}
      </Each>
    </View>
  );
}

function ChildStepCard(props: { step: SessionChildStep }) {
  const totalTok = computed(() => (props.step.inputTokens ?? 0) + (props.step.outputTokens ?? 0));
  return (
    <View testID={`swarm-transcript-step-${props.step.stepIndex}`} class="gap-1 rounded-md border border-line bg-page p-2">
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-1.5">
          <Text class="font-mono text-2xs font-semibold text-faint">{`#${props.step.stepIndex}`}</Text>
          <Text class="text-2xs font-medium text-muted">{props.step.kind}</Text>
          <If when={props.step.model}>{(m) => <Text class="font-mono text-2xs text-faint">{m()}</Text>}</If>
        </View>
        <If when={totalTok() > 0}>
          <Text class="font-mono text-2xs text-faint tabular-nums">
            {`${formatTokens(props.step.inputTokens ?? 0)}→${formatTokens(props.step.outputTokens ?? 0)}`}
          </Text>
        </If>
      </View>
      <If when={props.step.thinking}>{(th) => <Text class="truncate text-2xs text-faint">{`${t("web.shell.swarm.transcriptThinking")}: ${th()}`}</Text>}</If>
      <If when={props.step.toolCalls.length > 0}>
        <View class="flex-row flex-wrap gap-1">
          <Each of={props.step.toolCalls} key={(_, idx) => idx}>
            {(tc) => (
              <View class="max-w-full flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5 py-0.5">
                <Text class="shrink-0 font-mono text-2xs font-semibold text-ink">{tc().name}</Text>
                <If when={tc().args}>{(args) => <Text class="min-w-0 truncate font-mono text-2xs text-muted">{args()}</Text>}</If>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={props.step.content}>{(body) => <Text class="text-xs text-ink select-text">{body()}</Text>}</If>
      <If when={props.step.error}>
        {(err) => (
          <View class="rounded-sm bg-bad-soft px-2 py-1">
            <Text class="font-mono text-2xs text-berry select-text">{err()}</Text>
          </View>
        )}
      </If>
    </View>
  );
}

export interface SwarmPanelProps {
  readonly sessionId: string;
  readonly swarm: SessionSwarmState;
  readonly onClose: () => void;
}

export function SwarmPanel(props: SwarmPanelProps) {
  const tab = signal<SwarmTab>("overview");
  const selectedMemberName = signal<string | undefined>(undefined);
  const transcriptLoading = signal(false);
  const transcriptError = signal<string | undefined>(undefined);
  const transcriptSteps = signal<readonly SessionChildStep[]>([]);
  const boardAgentFilter = signal<string>("all");
  const boardQuery = signal("");
  const boardReversed = signal(false);
  const showTranscriptSkeleton = useDelayedBusy(() => transcriptLoading());
  let transcriptGen = 0;

  const sortedMembers = computed((): readonly SessionSwarmMember[] => {
    const list = props.swarm.members;
    return [...list.filter((m) => m.role === "coordinator"), ...list.filter((m) => m.role !== "coordinator")];
  });

  const memberMap = computed((): ReadonlyMap<string, SessionSwarmMember> => new Map(props.swarm.members.map((m) => [m.name, m])));

  const activeMember = computed((): SessionSwarmMember | undefined => {
    const name = selectedMemberName();
    return name ? memberMap().get(name) : undefined;
  });

  const loadTranscript = (member: SessionSwarmMember) => {
    if (!props.sessionId || !member.conversationId) {
      transcriptSteps.set([]);
      transcriptError.set(undefined);
      transcriptLoading.set(false);
      return;
    }
    const gen = ++transcriptGen;
    transcriptLoading.set(true);
    transcriptError.set(undefined);
    void fetchChildTranscript(props.sessionId, member.conversationId, 25).then((res) => {
      if (gen !== transcriptGen) return;
      transcriptLoading.set(false);
      if (res.ok) {
        transcriptSteps.set(res.steps);
      } else {
        transcriptSteps.set([]);
        transcriptError.set(t("web.shell.swarm.transcriptFailed", { why: res.reason }));
      }
    });
  };

  const inspectMember = (name: string) => {
    tab.set("roster");
    selectedMemberName.set(name);
    const member = memberMap().get(name);
    if (member) loadTranscript(member);
  };

  effect(() => {
    const cur = selectedMemberName();
    if (cur && !memberMap().has(cur)) {
      selectedMemberName.set(undefined);
      transcriptSteps.set([]);
    }
  });

  const boardAgents = computed((): readonly string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of props.swarm.members) {
      if (!seen.has(m.name)) {
        seen.add(m.name);
        out.push(m.name);
      }
    }
    for (const msg of props.swarm.messages) {
      if (!seen.has(msg.agent)) {
        seen.add(msg.agent);
        out.push(msg.agent);
      }
    }
    return out;
  });

  const filteredMessages = computed((): readonly SessionSwarmMessage[] => {
    const agent = boardAgentFilter();
    const q = boardQuery().trim().toLowerCase();
    const list = props.swarm.messages.filter((m) => {
      if (agent !== "all" && m.agent !== agent) return false;
      if (q.length > 0 && !m.text.toLowerCase().includes(q) && !m.agent.toLowerCase().includes(q) && !`#${m.seq}`.includes(q)) return false;
      return true;
    });
    return boardReversed() ? [...list].toReversed() : list;
  });

  const tabs: readonly { id: SwarmTab; label: string; count?: () => number }[] = [
    { id: "overview", label: t("web.shell.swarm.tabOverview") },
    { id: "roster", label: t("web.shell.swarm.tabRoster"), count: () => props.swarm.members.length },
    { id: "board", label: t("web.shell.swarm.tabBoard"), count: () => props.swarm.totalMessages },
  ];

  const hasOverviewContent = computed(() => {
    const ov = props.swarm.overview;
    return Boolean(ov && (ov.goalTitle || ov.goalLine || ov.threads.length > 0));
  });

  return (
    <View testID="chat-swarm-panel" class="h-64 max-h-[45%] shrink-0 overflow-hidden border-b border-line bg-side">
      <View class="h-8 shrink-0 flex-row items-center justify-between gap-2 border-b border-line px-3">
        <View class="min-w-0 flex-1 flex-row items-center gap-2 overflow-hidden">
          <Icon name="agents" size={13} tone="muted" />
          <Text class="min-w-0 shrink truncate text-xs font-semibold text-ink">{props.swarm.title ?? "Swarm"}</Text>
          <View role="tablist" class="shrink-0 flex-row items-center gap-0.5">
            <Each of={tabs} key={(item) => item.id}>
              {(item) => {
                const active = () => tab() === item().id;
                const badgeCount = () => item().count?.() ?? 0;
                return (
                  <View
                    role="tab"
                    testID={`swarm-tab-${item().id}`}
                    accessibilityState={{ selected: active() }}
                    onPress={() => tab.set(item().id)}
                    class={`h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${
                      active() ? "bg-selected" : ""
                    }`}
                  >
                    <Text class={`text-xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{item().label}</Text>
                    <If when={badgeCount() > 0}>
                      <Text class="font-mono text-2xs text-faint tabular-nums">{String(badgeCount())}</Text>
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>
        </View>
        <ShellIconButton compact icon="close" size={11} label={t("web.shell.swarm.closeDrawer")} onPress={props.onClose} />
      </View>

      <If when={tab() === "overview"}>
        <View testID="swarm-overview" class="min-h-0 flex-1">
          <Scroll class="min-h-0 flex-1" contentClass="gap-2 p-3">
            <If when={hasOverviewContent()} else={<Text class="py-4 text-center text-xs text-muted">{t("web.shell.swarm.overviewEmpty")}</Text>}>
              <If when={props.swarm.overview?.goalTitle || props.swarm.overview?.goalLine}>
                <View class="gap-0.5 rounded-lg border border-line bg-page px-3 py-2">
                  <If when={props.swarm.overview?.goalTitle}>{(title) => <Text class="text-xs font-semibold text-ink">{title()}</Text>}</If>
                  <If when={props.swarm.overview?.goalLine}>{(line) => <Text class="text-xs text-muted">{line()}</Text>}</If>
                </View>
              </If>
              <Each of={props.swarm.overview?.threads ?? []} key={(th) => th.id}>
                {(thread) => <ThreadCard thread={thread()} overview={props.swarm.overview!} memberMap={memberMap()} onSelectMember={inspectMember} />}
              </Each>
            </If>
          </Scroll>
        </View>
      </If>

      <If when={tab() === "roster"}>
        <View testID="swarm-roster" class="min-h-0 flex-1 flex-row">
          <Scroll class="w-48 shrink-0 border-r border-line" contentClass="gap-1 p-2">
            <Each of={sortedMembers()} key={(m) => m.name}>
              {(member) => {
                const selected = () => selectedMemberName() === member().name;
                return (
                  <View
                    role="button"
                    testID={`swarm-member-${member().name}`}
                    accessibilityState={{ selected: selected() }}
                    onPress={() => inspectMember(member().name)}
                    class={`gap-0.5 rounded-md px-2 py-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${
                      selected() ? "bg-selected" : ""
                    }`}
                  >
                    <View class="flex-row items-center gap-1.5">
                      <Dot tone={memberStateTone(member().state)} size={6} ring={false} />
                      <Text class="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-ink">{member().name}</Text>
                      <Text class="shrink-0 text-2xs text-faint">
                        {member().role === "coordinator" ? t("web.shell.swarm.roleCoordinator") : t("web.shell.swarm.roleWorker")}
                      </Text>
                    </View>
                    <Text class="truncate text-2xs text-muted">{memberStateLabel(member())}</Text>
                    <If when={member().model || member().workspaceMode}>
                      <Text class="truncate font-mono text-2xs text-faint">{[member().model, member().workspaceMode].filter(Boolean).join(" · ")}</Text>
                    </If>
                  </View>
                );
              }}
            </Each>
          </Scroll>

          <View class="min-w-0 flex-1">
            <If
              when={activeMember()}
              else={
                <View class="flex-1 items-center justify-center p-4">
                  <Text class="text-xs text-muted">{t("web.shell.swarm.rosterSelectHint")}</Text>
                </View>
              }
            >
              {(member) => (
                <View testID="swarm-transcript" class="min-h-0 flex-1">
                  <View class="h-7 shrink-0 flex-row items-center justify-between gap-2 border-b border-line px-3">
                    <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                      <Text class="shrink-0 font-mono text-xs font-semibold text-ink">{member().name}</Text>
                      <Text class="min-w-0 truncate text-2xs text-muted">{t("web.shell.swarm.transcriptTitle")}</Text>
                    </View>
                    <ShellIconButton
                      compact
                      icon="refresh"
                      size={11}
                      label={t("web.shell.swarm.transcriptRefresh")}
                      onPress={() => loadTranscript(untracked(member))}
                    />
                  </View>
                  <Scroll class="min-h-0 flex-1" contentClass="gap-1.5 p-2.5">
                    <If when={showTranscriptSkeleton()}>
                      <SkeletonLines testID="swarm-transcript-skeleton" rows={["46%", "88%", "72%", "60%"]} gap="md" />
                    </If>
                    <If when={!transcriptLoading() && transcriptError()}>
                      {(err) => (
                        <View class="rounded-md bg-bad-soft px-2.5 py-1.5">
                          <Text class="text-xs text-berry">{err()}</Text>
                        </View>
                      )}
                    </If>
                    <If when={!transcriptLoading() && !transcriptError() && transcriptSteps().length === 0}>
                      <Text class="py-4 text-center text-xs text-muted">{t("web.shell.swarm.transcriptEmpty")}</Text>
                    </If>
                    <If when={!transcriptLoading()}>
                      <Each of={transcriptSteps()} key={(st) => st.stepIndex}>
                        {(st) => <ChildStepCard step={st()} />}
                      </Each>
                    </If>
                  </Scroll>
                </View>
              )}
            </If>
          </View>
        </View>
      </If>

      <If when={tab() === "board"}>
        <View testID="swarm-board" class="min-h-0 flex-1">
          <View class="shrink-0 flex-row flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5">
            <View
              role="button"
              testID="swarm-board-filter-all"
              onPress={() => boardAgentFilter.set("all")}
              class={`h-5 items-center justify-center rounded-sm px-1.5 hover:bg-hover ${boardAgentFilter() === "all" ? "bg-selected" : ""}`}
            >
              <Text class={`text-2xs font-medium ${boardAgentFilter() === "all" ? "text-ink" : "text-muted"}`}>{t("web.shell.swarm.boardAll")}</Text>
            </View>
            <Each of={boardAgents()} key={(name) => name}>
              {(agent) => (
                <View
                  role="button"
                  testID={`swarm-board-filter-${agent()}`}
                  onPress={() => boardAgentFilter.set(agent())}
                  class={`h-5 items-center justify-center rounded-sm px-1.5 hover:bg-hover ${boardAgentFilter() === agent() ? "bg-selected" : ""}`}
                >
                  <Text class={`font-mono text-2xs ${boardAgentFilter() === agent() ? "font-semibold text-ink" : "text-muted"}`}>{agent()}</Text>
                </View>
              )}
            </Each>
            <View class="min-w-28 flex-1">
              <Input
                testID="swarm-board-search"
                value={boardQuery()}
                onChange={(e) => boardQuery.set(e.value)}
                placeholder={t("web.shell.swarm.boardFilterPlaceholder")}
                accessibilityLabel={t("web.shell.swarm.boardFilterPlaceholder")}
                class="h-6 rounded-md border border-line bg-page px-2 text-xs text-ink placeholder:text-faint"
              />
            </View>
            <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">
              {t("web.shell.swarm.boardCount", { shown: filteredMessages().length, total: props.swarm.totalMessages })}
            </Text>
            <View
              role="button"
              testID="swarm-board-latest"
              onPress={() => boardReversed.set(!boardReversed())}
              class={`h-5 shrink-0 items-center justify-center rounded-sm px-1.5 hover:bg-hover ${boardReversed() ? "bg-selected" : ""}`}
            >
              <Text class="text-2xs font-medium text-muted">{t("web.shell.swarm.boardJumpLatest")}</Text>
            </View>
          </View>
          <Scroll class="min-h-0 flex-1" contentClass="gap-1.5 p-2.5">
            <If when={filteredMessages().length === 0}>
              <Text class="py-4 text-center text-xs text-muted">{t("web.shell.swarm.boardEmpty")}</Text>
            </If>
            <Each of={filteredMessages()} key={(m) => m.seq}>
              {(msg) => (
                <View testID={`swarm-msg-${msg().seq}`} class="gap-1 rounded-md border border-line bg-page px-2.5 py-2">
                  <View class="flex-row items-center gap-1.5">
                    <Text class="font-mono text-2xs font-semibold text-faint">{`#${msg().seq}`}</Text>
                    <View
                      role="button"
                      testID={`swarm-msg-agent-${msg().seq}`}
                      onPress={() => inspectMember(msg().agent)}
                      class="rounded-sm bg-side px-1.5 py-px hover:bg-hover"
                    >
                      <Text class="font-mono text-2xs font-semibold text-ink">{msg().agent}</Text>
                    </View>
                    <If when={msg().kind === "brief"}>
                      <View class="rounded-sm bg-warn-soft px-1.5 py-px">
                        <Text class="text-2xs font-medium text-warn-ink">{t("web.shell.swarm.boardBrief")}</Text>
                      </View>
                    </If>
                    <View class="flex-1" />
                    <Text class="font-mono text-2xs text-faint tabular-nums">{formatMessageTime(msg().time)}</Text>
                  </View>
                  <BoardMessageBody text={msg().text} />
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </If>
    </View>
  );
}
