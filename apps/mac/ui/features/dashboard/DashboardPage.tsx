import { computed, Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { isFreeUserSession, isOrchestratorSession, sessionIssueId, sessionProfile } from "@vibevalley/protocol/rules";

import { ButtonLink } from "../../design/Button";
import { AgentFace, OrchestratorFace, UserAvatar } from "../../design/domain/Face";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { Quiet } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { CountPill, Dot, type DotTone } from "../../design/Tag";
import { useOrchestrators } from "../../infra/agents";
import { useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { useBoardSlice, useInboxSlice, useSessionsSlice } from "../../infra/frame";
import { ready, useAgents, useQuery, useSettings } from "../../infra/query";
import { Link as A, useRouter } from "../../infra/router";
import { waitingOnUser } from "../inbox";
import { allSessionsQuery, buildRunEntries, runActivityAt, type RunApprovals, type RunEntry, RunsPage, type RunStatusBadge, runStatusOf } from "../session";
import { RetroView } from "./RetroView";

export type DashboardTab = "overview" | "retro" | "runs";

function tabPath(tab: DashboardTab): string {
  switch (tab) {
    case "overview":
      return "/dashboard";
    case "retro":
      return "/dashboard/retro";
    case "runs":
      return "/dashboard/runs";
  }
}

function statusDot(badge: RunStatusBadge): DotTone {
  switch (badge) {
    case "working":
      return "water";
    case "listening":
    case "done":
      return "leaf";
    case "resting":
    case "interrupted":
      return "wheat";
    case "failed":
      return "berry";
    case "closed":
      return "idle";
  }
}

function entryTitle(entry: RunEntry): string {
  switch (entry.kind) {
    case "orchestrator":
      return entry.agent.name;
    case "worker":
      return entry.live?.name ?? entry.session.name;
  }
}

function StatCard(props: { href: string; testid: string; icon: IconName; label: string; count: number; tone?: "default" | "bad" | "water" }) {
  const numClass = () => {
    switch (props.tone) {
      case "bad":
        return "text-berry";
      case "water":
        return "text-water";
      default:
        return "text-ink";
    }
  };
  return (
    <A
      href={props.href}
      testID={props.testid}
      class="min-w-36 flex-1 rounded-xl border border-line bg-elevated px-3.5 py-3 hover:border-faint hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
    >
      <View class="flex-row items-center justify-between gap-2">
        <Text class="truncate text-xs font-medium text-muted">{props.label}</Text>
        <Icon name={props.icon} size={14} tone="muted" />
      </View>
      <Text class={`mt-1.5 font-mono text-xl font-semibold tabular-nums ${numClass()}`}>{String(props.count)}</Text>
    </A>
  );
}

function QuickLinkCard(props: { href: string; testid: string; icon: IconName; label: string; hint: string }) {
  return (
    <A
      href={props.href}
      testID={props.testid}
      class="min-w-0 flex-row items-center gap-3 rounded-xl border border-line bg-elevated px-3.5 py-3 hover:border-faint hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
    >
      <View class="size-8 shrink-0 items-center justify-center rounded-md bg-side">
        <Icon name={props.icon} size={16} tone="ink" />
      </View>
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class="truncate text-sm font-medium text-ink">{props.label}</Text>
        <Text class="text-xs leading-snug text-muted">{props.hint}</Text>
      </View>
    </A>
  );
}

function DashboardOverview() {
  const settings = useSettings();
  const sessionsSlice = useSessionsSlice();
  const board = useBoardSlice();
  const inbox = useInboxSlice();
  const orchestrators = useOrchestrators();
  const agents = useAgents();
  const sessions = useQuery(allSessionsQuery);
  const now = useNow();

  const profile = () => ready(settings, undefined)?.profile;
  const displayName = () => profile()?.displayName?.trim() || t("web.base.dashboard.profile.defaultName");
  const tagline = () => profile()?.tagline?.trim() || t("web.base.dashboard.profile.defaultTagline");

  const workingSessions = computed(() => (sessionsSlice()?.sessions ?? []).filter((s) => !isFreeUserSession(s) && s.phase._tag === "working"));
  const waitingCount = computed(() => waitingOnUser(inbox()?.items ?? []));
  const openIssueCount = computed(() => (board()?.issues ?? []).filter((i) => i.status === "todo" || i.status === "in_progress").length);
  const reviewIssueCount = computed(() => (board()?.issues ?? []).filter((i) => i.status === "in_review").length);
  const todoIssueCount = computed(() => (board()?.issues ?? []).filter((i) => i.status === "todo").length);

  const agentById = computed(() => new Map(ready(agents, []).map((a) => [a.id, a])));
  const recentRuns = computed(() =>
    buildRunEntries({
      orchestrators: orchestrators(),
      sessions: ready(sessions, []),
      liveSessions: sessionsSlice()?.sessions ?? [],
      issues: board()?.issues ?? [],
    }).slice(0, 5),
  );

  return (
    <Scroll testID="dashboard-overview" class="min-h-0 flex-1 bg-page" contentClass="mx-auto w-full max-w-5xl gap-5 p-6">
      <View testID="dashboard-profile-card" class="flex-row flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-elevated px-5 py-4">
        <View class="min-w-0 flex-1 flex-row items-center gap-4">
          <UserAvatar size={52} />
          <View class="min-w-0 flex-1 gap-0.5">
            <Text testID="dashboard-profile-name" class="truncate text-lg font-semibold text-ink">
              {displayName()}
            </Text>
            <Text testID="dashboard-profile-tagline" class="truncate text-xs text-muted">
              {tagline()}
            </Text>
          </View>
        </View>
        <ButtonLink href="/settings/profile" tone="plain" size="compact" icon="edit" testID="dashboard-edit-profile">
          {t("web.base.dashboard.profile.edit")}
        </ButtonLink>
      </View>

      <View class="flex-row flex-wrap gap-3">
        <StatCard
          href="/dashboard/runs?scope=active"
          testid="dashboard-stat-working"
          icon="log"
          label={t("web.base.dashboard.stats.working")}
          count={workingSessions().length}
          tone={workingSessions().length > 0 ? "water" : "default"}
        />
        <StatCard
          href="/chat"
          testid="dashboard-stat-waiting"
          icon="chat"
          label={t("web.base.dashboard.stats.waiting")}
          count={waitingCount()}
          tone={waitingCount() > 0 ? "bad" : "default"}
        />
        <StatCard
          href="/issues?status=todo,in_progress"
          testid="dashboard-stat-issues"
          icon="issues"
          label={t("web.base.dashboard.stats.issues")}
          count={openIssueCount()}
        />
        <StatCard
          href="/issues?status=in_review"
          testid="dashboard-stat-review"
          icon="check"
          label={t("web.base.dashboard.stats.review")}
          count={reviewIssueCount()}
        />
      </View>

      <View class="flex-row flex-wrap items-start gap-4">
        <View testID="dashboard-pulse" class="min-w-72 flex-1 rounded-xl border border-line bg-elevated">
          <View class="flex-row items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <View class="flex-row items-center gap-2">
              <Text class="text-xs font-semibold text-muted">{t("web.base.dashboard.pulse.title")}</Text>
              <CountPill count={workingSessions().length} />
              <If when={workingSessions().length > 0}>
                <Text class="text-2xs text-faint">{t("web.base.dashboard.pulse.active", { n: workingSessions().length })}</Text>
              </If>
            </View>
            <A href="/dashboard/runs" testID="dashboard-open-runs" class="text-xs font-medium text-water hover:underline">
              {t("web.base.dashboard.pulse.openRuns")}
            </A>
          </View>
          <If
            when={workingSessions().length > 0}
            else={
              <View class="px-4 py-5">
                <Quiet>{t("web.base.dashboard.pulse.empty")}</Quiet>
              </View>
            }
          >
            <View>
              <Each of={workingSessions().slice(0, 6)} key={(s) => s.id}>
                {(s, i) => {
                  const profileId = () => sessionProfile(s()) ?? "";
                  const issueId = () => sessionIssueId(s());
                  const isOrch = () => isOrchestratorSession(s());
                  return (
                    <A
                      href={`/dashboard/runs?session=${encodeURIComponent(s().id)}`}
                      class={`flex-row items-center gap-3 px-4 py-2.5 hover:bg-hover ${i() > 0 ? "border-t border-line" : ""}`}
                    >
                      <If
                        when={isOrch()}
                        else={<AgentFace agentId={profileId()} name={s().name} runtime={s().runtime} look={agentById().get(profileId())?.look} size={26} />}
                      >
                        <OrchestratorFace size={26} agent={profileId()} />
                      </If>
                      <View class="min-w-0 flex-1 gap-0.5">
                        <Text class="truncate text-sm font-medium text-ink">{s().name}</Text>
                        <Text class="truncate text-xs text-muted">{s().phaseText || issueId() || s().runtime}</Text>
                      </View>
                      <Dot tone="water" size={7} ring={false} />
                    </A>
                  );
                }}
              </Each>
            </View>
          </If>
        </View>

        <View testID="dashboard-pending" class="min-w-64 flex-1 rounded-xl border border-line bg-elevated">
          <View class="flex-row items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <Text class="text-xs font-semibold text-muted">{t("web.base.dashboard.pending.title")}</Text>
            <A href="/issues" testID="dashboard-open-issues" class="text-xs font-medium text-water hover:underline">
              {t("web.base.dashboard.pending.openIssues")}
            </A>
          </View>
          <View class="gap-2.5 px-4 py-3">
            <A href="/chat" class="flex-row items-center justify-between rounded-md px-2 py-1.5 hover:bg-hover">
              <Text class="text-sm text-ink">{t("web.base.dashboard.pending.waiting", { n: waitingCount() })}</Text>
              <CountPill count={waitingCount()} tone={waitingCount() > 0 ? "bad" : "neutral"} />
            </A>
            <A
              href="/issues?status=in_review"
              testID="dashboard-pending-review"
              class="flex-row items-center justify-between rounded-md px-2 py-1.5 hover:bg-hover"
            >
              <Text class="text-sm text-ink">{t("web.base.dashboard.pending.inReview", { n: reviewIssueCount() })}</Text>
              <CountPill count={reviewIssueCount()} />
            </A>
            <A href="/issues?status=todo" testID="dashboard-pending-todo" class="flex-row items-center justify-between rounded-md px-2 py-1.5 hover:bg-hover">
              <Text class="text-sm text-ink">{t("web.base.dashboard.pending.todo", { n: todoIssueCount() })}</Text>
              <CountPill count={todoIssueCount()} />
            </A>
          </View>
        </View>
      </View>

      <View testID="dashboard-recent-runs" class="rounded-xl border border-line bg-elevated">
        <View class="flex-row items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <Text class="text-xs font-semibold text-muted">{t("web.base.dashboard.recent.title")}</Text>
          <A href="/dashboard/runs" class="text-xs font-medium text-water hover:underline">
            {t("web.base.dashboard.pulse.openRuns")}
          </A>
        </View>
        <If
          when={recentRuns().length > 0}
          else={
            <View class="px-4 py-5">
              <Quiet>{t("web.base.dashboard.recent.empty")}</Quiet>
            </View>
          }
        >
          <View>
            <Each of={recentRuns()} key={(entry) => `${entry.kind}:${entry.id}`}>
              {(entry, i) => {
                const badge = () => runStatusOf(entry());
                const at = () => runActivityAt(entry());
                return (
                  <A
                    href={`/dashboard/runs?session=${encodeURIComponent(entry().id)}`}
                    class={`flex-row items-center justify-between gap-3 px-4 py-2.5 hover:bg-hover ${i() > 0 ? "border-t border-line" : ""}`}
                  >
                    <View class="min-w-0 flex-1 flex-row items-center gap-2.5">
                      <Dot tone={statusDot(badge())} size={7} ring={false} />
                      <Text class="truncate text-sm font-medium text-ink">{entryTitle(entry())}</Text>
                      <Text class="truncate text-xs text-muted">{t(`web.session.hub.status.${badge()}`)}</Text>
                    </View>
                    <If when={at() > 0}>
                      <Text class="shrink-0 font-mono text-xs text-faint tabular-nums">{ago(at(), now())}</Text>
                    </If>
                  </A>
                );
              }}
            </Each>
          </View>
        </If>
      </View>

      <View class="gap-2">
        <Text class="px-0.5 text-xs font-semibold text-muted">{t("web.base.dashboard.quick.title")}</Text>
        <View class="grid gap-3 md:grid-cols-2">
          <QuickLinkCard
            href="/issues"
            testid="dashboard-quick-issues"
            icon="issues"
            label={t("web.base.place.issues.label")}
            hint={t("web.base.place.issues.hint")}
          />
          <QuickLinkCard href="/chat" testid="dashboard-quick-chat" icon="chat" label={t("web.base.place.chat.label")} hint={t("web.base.place.chat.hint")} />
          <QuickLinkCard href="/farm" testid="dashboard-quick-farm" icon="farm" label={t("web.base.place.farm.label")} hint={t("web.base.place.farm.hint")} />
          <QuickLinkCard href="/settings/mcp" testid="dashboard-quick-mcp" icon="plug" label={t("web.setting.nav.mcp")} hint={t("web.setting.mcp.intro")} />
        </View>
      </View>
    </Scroll>
  );
}

export function DashboardPage(props: { tab?: DashboardTab | undefined; approvals?: RunApprovals }) {
  const router = useRouter();
  const sessionsSlice = useSessionsSlice();
  const tab = () => props.tab ?? "overview";
  const activeCount = computed(() => (sessionsSlice()?.sessions ?? []).filter((s) => !isFreeUserSession(s) && s.phase._tag === "working").length);
  return (
    <View testID="dashboard-page" class="h-full min-h-0 flex-1 bg-page">
      <View
        testID="dashboard-header"
        desktop={{ windowDrag: true }}
        class="h-11 shrink-0 flex-row items-center justify-between gap-3 border-b border-line bg-page px-4"
      >
        <View class="min-w-0 flex-row items-center gap-2">
          <UserAvatar size={22} />
          <Text role="header" class="truncate text-sm font-semibold text-ink">
            {t("web.base.dashboard.title")}
          </Text>
        </View>
        <Segmented
          label={t("web.base.dashboard.tabsLabel")}
          testid="dashboard-tabs"
          value={tab()}
          options={[
            { value: "overview", label: t("web.base.dashboard.tab.overview") },
            { value: "retro", label: t("web.base.dashboard.tab.retro") },
            {
              value: "runs",
              label: t("web.base.dashboard.tab.runs"),
              count: activeCount() > 0 ? activeCount() : undefined,
              countTone: "water",
            },
          ]}
          onChange={(next) => router.navigate(tabPath(next))}
        />
      </View>
      <If when={tab() === "overview"}>
        <DashboardOverview />
      </If>
      <If when={tab() === "retro"}>
        <RetroView />
      </If>
      <If when={tab() === "runs"}>
        <View class="min-h-0 flex-1">
          <RunsPage approvals={props.approvals} />
        </View>
      </If>
    </View>
  );
}
