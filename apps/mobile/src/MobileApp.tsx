import { cleanup, effect, locale, safeArea, signal, Text, View } from "nsh";
import { isAvailable as mobileAvailable, TabBar, type TabBarItem } from "nsh/mobile";

import { t } from "@vibevalley/i18n";
import type { InboxItem } from "@vibevalley/protocol";
import type { RemoteConnectionState } from "@vibevalley/protocol/remote";

import type { IconName } from "../design/icons";
import { Icon } from "./design/Icon";
import { PillButton, SafeScreen, StatusTag, type TagTone } from "./design/ui";
import { ChannelsTab } from "./features/ChannelsTab";
import { InboxTab } from "./features/InboxTab";
import { IssuesTab } from "./features/IssuesTab";
import { PairScreen } from "./features/PairScreen";
import { SessionsTab } from "./features/SessionsTab";
import { syncMobileLocale } from "./infra/i18nBoot";
import { createRemoteSession, hapticSelection } from "./infra/session";

type MobileTabId = "inbox" | "channels" | "sessions" | "issues";

const TAB_ORDER: readonly MobileTabId[] = ["inbox", "channels", "sessions", "issues"];

const TAB_ICONS: Record<MobileTabId, { readonly reicon: IconName; readonly sfSymbol: string }> = {
  inbox: { reicon: "inbox", sfSymbol: "tray.full" },
  channels: { reicon: "chat", sfSymbol: "bubble.left.and.bubble.right" },
  sessions: { reicon: "terminal", sfSymbol: "cpu" },
  issues: { reicon: "issues", sfSymbol: "checklist" },
};

function tabTitle(id: MobileTabId): string {
  switch (id) {
    case "inbox":
      return t("web.remote.tabs.inbox");
    case "channels":
      return t("web.remote.tabs.channels");
    case "sessions":
      return t("web.remote.tabs.sessions");
    case "issues":
      return t("web.remote.tabs.issues");
  }
}

function connectionTag(state: RemoteConnectionState): { readonly label: string; readonly tone: TagTone } {
  switch (state) {
    case "connecting":
      return { label: t("web.remote.state.connecting"), tone: "info" };
    case "connected":
      return { label: t("web.remote.state.connected"), tone: "ok" };
    case "reconnecting":
      return { label: t("web.remote.state.reconnecting"), tone: "wait" };
    case "unauthorized":
      return { label: t("web.remote.state.unauthorized"), tone: "bad" };
    case "offline":
      return { label: t("web.remote.state.offline"), tone: "neutral" };
  }
}

export interface MobileAppProps {
  readonly fetchImpl?: typeof fetch;
}

export function MobileApp(props: MobileAppProps = {}) {
  const session = createRemoteSession(props.fetchImpl ? { fetch: props.fetchImpl } : undefined);
  cleanup(() => session.dispose());

  effect(() => {
    locale();
    syncMobileLocale();
  });

  const activeTab = signal<MobileTabId>("inbox");
  const selectedChannelId = signal<string | undefined>(undefined);
  const selectedSessionId = signal<string | undefined>(undefined);
  const selectedIssueId = signal<string | undefined>(undefined);

  const inboxBadgeCount = () => session.pendingPermissions().length + session.pendingInteractions().length + (session.inbox()?.items.length ?? 0);

  const activeSessionsCount = () => (session.sessions()?.sessions ?? []).filter((s) => s.phase._tag === "working").length;

  const badgeForTab = (tab: MobileTabId): number => {
    switch (tab) {
      case "inbox":
        return inboxBadgeCount();
      case "sessions":
        return activeSessionsCount();
      case "channels":
        return session.collab()?.channelSummary?.unreadTotal ?? 0;
      case "issues":
        return 0;
    }
  };

  const tabBarItems = (): TabBarItem[] =>
    TAB_ORDER.map((id) => {
      const count = badgeForTab(id);
      return {
        title: tabTitle(id),
        icon: TAB_ICONS[id].sfSymbol,
        badge: count > 0 ? String(count) : null,
      };
    });

  const handleNavigateTarget = (target: InboxItem["target"]) => {
    switch (target.kind) {
      case "chat":
        selectedChannelId.set(target.channel);
        activeTab.set("channels");
        break;
      case "session":
        selectedSessionId.set(target.id);
        activeTab.set("sessions");
        break;
      case "issue":
        selectedIssueId.set(target.id);
        activeTab.set("issues");
        break;
      case "runtime":
        if (target.sessionId !== undefined) selectedSessionId.set(target.sessionId);
        activeTab.set("sessions");
        break;
    }
  };

  const handleDisconnect = () => {
    selectedChannelId.set(undefined);
    selectedSessionId.set(undefined);
    selectedIssueId.set(undefined);
    activeTab.set("inbox");
    void session.disconnect();
  };

  return (
    <If when={session.credentials()} else={<PairScreen session={session} />}>
      {(creds) => {
        const status = () => connectionTag(session.connectionState());
        return (
          <SafeScreen testID="mobile-home" bottomInset={!mobileAvailable}>
            <View testID="mobile-header" class="flex-row items-center justify-between gap-2.5 border-b border-line bg-side px-4 py-2.5">
              <View class="min-w-0 flex-1 gap-1">
                <Text testID="server-name" class="truncate text-base font-bold text-ink">
                  {creds().serverName}
                </Text>
                <StatusTag testID="connection-status" label={status().label} tone={status().tone} dot />
              </View>
              <PillButton
                testID="disconnect-button"
                size="sm"
                tone="plain"
                icon="close"
                label={t("web.remote.state.disconnect")}
                onPress={() => handleDisconnect()}
              />
            </View>

            <View class="min-h-0 flex-1">
              <If when={activeTab() === "inbox"}>
                <InboxTab session={session} onNavigateTarget={handleNavigateTarget} />
              </If>
              <If when={activeTab() === "channels"}>
                <ChannelsTab session={session} selectedChannelId={selectedChannelId} onSelectChannel={(id) => selectedChannelId.set(id)} />
              </If>
              <If when={activeTab() === "sessions"}>
                <SessionsTab session={session} selectedSessionId={selectedSessionId} onSelectSession={(id) => selectedSessionId.set(id)} />
              </If>
              <If when={activeTab() === "issues"}>
                <IssuesTab session={session} selectedIssueId={selectedIssueId} onSelectIssue={(id) => selectedIssueId.set(id)} />
              </If>
            </View>

            <If
              when={mobileAvailable}
              else={
                <View
                  testID="mobile-tabbar"
                  class="flex-row items-center border-t border-line bg-side px-2 py-1.5"
                  style={{ paddingBottom: Math.max(6, safeArea().bottom) }}
                >
                  <Each of={TAB_ORDER} key={(id) => id}>
                    {(id) => {
                      const active = () => activeTab() === id();
                      const count = () => badgeForTab(id());
                      return (
                        <View
                          role="button"
                          testID={`tab-${id()}`}
                          accessibilityLabel={tabTitle(id())}
                          onPress={() => {
                            hapticSelection();
                            activeTab.set(id());
                          }}
                          class={`flex-1 items-center justify-center gap-1 rounded-lg py-1.5 ${active() ? "bg-selected" : "active:bg-hover"}`}
                        >
                          <View class="flex-row items-center gap-1">
                            <Icon name={TAB_ICONS[id()].reicon} size={18} tone={active() ? "accent" : "muted"} />
                            <If when={count() > 0}>
                              <View testID={`tab-badge-${id()}`} class="min-w-4 items-center justify-center rounded-full bg-accent px-1">
                                <Text class="font-mono text-2xs font-semibold text-page">{String(count())}</Text>
                              </View>
                            </If>
                          </View>
                          <Text class={`text-2xs ${active() ? "font-semibold text-accent" : "text-muted"}`}>{tabTitle(id())}</Text>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              }
            >
              <TabBar
                testID="native-tabbar"
                class="w-full"
                items={tabBarItems()}
                selectedIndex={TAB_ORDER.indexOf(activeTab())}
                onChange={(e) => {
                  const next = TAB_ORDER[e.index];
                  if (next !== undefined) {
                    hapticSelection();
                    activeTab.set(next);
                  }
                }}
              />
            </If>
          </SafeScreen>
        );
      }}
    </If>
  );
}
