import { cleanup, effect, locale, platform, signal, Text, View } from "nsh";
import { BackHandler, isAvailable as mobileAvailable, TabBar, type TabBarItem } from "nsh/mobile";

import { t } from "@vibevalley/i18n";
import type { InboxItem } from "@vibevalley/protocol";
import type { RemoteConnectionState } from "@vibevalley/protocol/remote";

import type { IconName } from "../design/icons";
import { Icon } from "./design/Icon";
import { NAV_RAIL_WIDTH, useMobileLayout } from "./design/layout";
import { PillButton, SafeScreen, StatusTag, type TagTone } from "./design/ui";
import { ChannelsTab } from "./features/ChannelsTab";
import { InboxTab } from "./features/InboxTab";
import { IssuesTab } from "./features/IssuesTab";
import { PairScreen } from "./features/PairScreen";
import { SessionsTab } from "./features/SessionsTab";
import { syncMobileLocale } from "./infra/i18nBoot";
import { subscribeNotificationPress, type NotificationRoute } from "./infra/notifications";
import { createRemoteSession, hapticSelection } from "./infra/session";

type MobileTabId = "inbox" | "channels" | "sessions" | "issues";

const TAB_ORDER: readonly MobileTabId[] = ["inbox", "channels", "sessions", "issues"];

const TAB_ICONS: Record<MobileTabId, { readonly reicon: IconName; readonly sfSymbol: string; readonly androidDrawable: string }> = {
  inbox: { reicon: "inbox", sfSymbol: "tray.full", androidDrawable: "android:ic_dialog_email" },
  channels: { reicon: "chat", sfSymbol: "bubble.left.and.bubble.right", androidDrawable: "android:ic_menu_send" },
  sessions: { reicon: "terminal", sfSymbol: "cpu", androidDrawable: "android:ic_menu_manage" },
  issues: { reicon: "issues", sfSymbol: "checklist", androidDrawable: "android:ic_menu_agenda" },
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

function connectionTag(state: RemoteConnectionState): { readonly label: string; readonly tone: TagTone; readonly dotClass: string } {
  switch (state) {
    case "connecting":
      return { label: t("web.remote.state.connecting"), tone: "info", dotClass: "bg-water" };
    case "connected":
      return { label: t("web.remote.state.connected"), tone: "ok", dotClass: "bg-leaf" };
    case "reconnecting":
      return { label: t("web.remote.state.reconnecting"), tone: "wait", dotClass: "bg-wheat" };
    case "unauthorized":
      return { label: t("web.remote.state.unauthorized"), tone: "bad", dotClass: "bg-berry" };
    case "offline":
      return { label: t("web.remote.state.offline"), tone: "neutral", dotClass: "bg-idle" };
  }
}

export interface MobileAppProps {
  readonly fetchImpl?: typeof fetch;
  readonly subscribeNotificationPress?: (onRoute: (route: NotificationRoute) => void) => () => void;
}

export function MobileApp(props: MobileAppProps = {}) {
  const session = createRemoteSession(props.fetchImpl ? { fetch: props.fetchImpl } : undefined);
  cleanup(() => session.dispose());

  effect(() => {
    locale();
    syncMobileLocale();
  });

  const layout = useMobileLayout();
  const isDualPane = () => layout().mode === "dual_pane";

  const activeTab = signal<MobileTabId>("inbox");
  const selectedInboxKey = signal<string | undefined>(undefined);
  const selectedChannelId = signal<string | undefined>(undefined);
  const selectedSessionId = signal<string | undefined>(undefined);
  const selectedIssueId = signal<string | undefined>(undefined);

  const handleNotificationRoute = (route: NotificationRoute) => {
    switch (route.tab) {
      case "inbox":
        if (route.key !== undefined) selectedInboxKey.set(route.key);
        activeTab.set("inbox");
        break;
      case "channels":
        selectedChannelId.set(route.channelId);
        activeTab.set("channels");
        break;
      case "sessions":
        selectedSessionId.set(route.sessionId);
        activeTab.set("sessions");
        break;
      case "issues":
        selectedIssueId.set(route.issueId);
        activeTab.set("issues");
        break;
    }
  };

  const stopNotificationPress = (props.subscribeNotificationPress ?? subscribeNotificationPress)(handleNotificationRoute);
  cleanup(() => stopNotificationPress());

  const stopBackHandler = BackHandler.on("press", () => {
    if (layout().mode !== "compact") return false;
    switch (activeTab()) {
      case "inbox":
        if (selectedInboxKey() !== undefined) {
          selectedInboxKey.set(undefined);
          return true;
        }
        return false;
      case "channels":
        if (selectedChannelId() !== undefined) {
          selectedChannelId.set(undefined);
          return true;
        }
        return false;
      case "sessions":
        if (selectedSessionId() !== undefined) {
          selectedSessionId.set(undefined);
          return true;
        }
        return false;
      case "issues":
        if (selectedIssueId() !== undefined) {
          selectedIssueId.set(undefined);
          return true;
        }
        return false;
    }
  });
  cleanup(() => stopBackHandler());

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
      const nativeIcon = platform.select({
        ios: TAB_ICONS[id].sfSymbol,
        android: TAB_ICONS[id].androidDrawable,
      });
      return {
        title: tabTitle(id),
        icon: nativeIcon ?? null,
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
    selectedInboxKey.set(undefined);
    selectedChannelId.set(undefined);
    selectedSessionId.set(undefined);
    selectedIssueId.set(undefined);
    activeTab.set("inbox");
    void session.disconnect();
  };

  const renderActiveTab = () => (
    <View class="min-h-0 flex-1">
      <If when={activeTab() === "inbox"}>
        <InboxTab
          session={session}
          layout={layout}
          selectedKey={selectedInboxKey}
          onSelectKey={(key) => selectedInboxKey.set(key)}
          onNavigateTarget={handleNavigateTarget}
        />
      </If>
      <If when={activeTab() === "channels"}>
        <ChannelsTab session={session} layout={layout} selectedChannelId={selectedChannelId} onSelectChannel={(id) => selectedChannelId.set(id)} />
      </If>
      <If when={activeTab() === "sessions"}>
        <SessionsTab session={session} layout={layout} selectedSessionId={selectedSessionId} onSelectSession={(id) => selectedSessionId.set(id)} />
      </If>
      <If when={activeTab() === "issues"}>
        <IssuesTab session={session} layout={layout} selectedIssueId={selectedIssueId} onSelectIssue={(id) => selectedIssueId.set(id)} />
      </If>
    </View>
  );

  return (
    <If when={session.credentials()} else={<PairScreen session={session} layout={layout} />}>
      {(creds) => {
        const status = () => connectionTag(session.connectionState());
        return (
          <If
            when={isDualPane()}
            else={
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

                {renderActiveTab()}

                <If
                  when={mobileAvailable}
                  else={
                    <View
                      testID="mobile-tabbar"
                      class="flex-row items-center border-t border-line bg-side px-2 py-1.5"
                      style={{ paddingBottom: Math.max(6, layout().safe.bottom) }}
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
            }
          >
            <View testID="mobile-home" class="flex-1 flex-row bg-page">
              <View
                testID="mobile-nav-rail"
                class="shrink-0 items-center justify-between border-r border-line bg-rail"
                style={{
                  width: NAV_RAIL_WIDTH + layout().safe.left,
                  paddingLeft: layout().safe.left,
                  paddingTop: Math.max(12, layout().safe.top),
                  paddingBottom: Math.max(12, layout().safe.bottom),
                }}
              >
                <View class="w-full items-center gap-1.5 px-1">
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
                          class={`w-full flex-row items-center rounded-lg px-1 py-2 ${active() ? "bg-selected" : "active:bg-hover"}`}
                        >
                          <View class={`h-5 w-1 shrink-0 rounded-full ${active() ? "bg-accent" : "bg-transparent"}`} />
                          <View class="min-w-0 flex-1 items-center gap-1">
                            <View class="flex-row items-center gap-1">
                              <Icon name={TAB_ICONS[id()].reicon} size={18} tone={active() ? "accent" : "on-rail"} />
                              <If when={count() > 0}>
                                <View testID={`tab-badge-${id()}`} class="min-w-4 items-center justify-center rounded-full bg-accent px-1">
                                  <Text class="font-mono text-2xs font-semibold text-page">{String(count())}</Text>
                                </View>
                              </If>
                            </View>
                            <Text class={`max-w-full truncate text-2xs ${active() ? "font-semibold text-accent" : "text-muted"}`}>{tabTitle(id())}</Text>
                          </View>
                        </View>
                      );
                    }}
                  </Each>
                </View>

                <View class="items-center gap-2.5 px-2">
                  <View testID="rail-connection-dot" class={`size-2.5 rounded-full ${status().dotClass}`} />
                  <View
                    role="button"
                    testID="rail-disconnect-button"
                    accessibilityLabel={t("web.remote.state.disconnect")}
                    onPress={() => handleDisconnect()}
                    class="size-9 items-center justify-center rounded-lg border border-line bg-page active:bg-hover"
                  >
                    <Icon name="close" size={16} tone="muted" />
                  </View>
                </View>
              </View>

              <View
                class="min-h-0 min-w-0 flex-1 bg-page"
                style={{
                  paddingTop: layout().safe.top,
                  paddingRight: layout().safe.right,
                  paddingBottom: layout().safe.bottom,
                }}
              >
                <View testID="mobile-header" class="flex-row items-center justify-between gap-2.5 border-b border-line bg-side px-4 py-2">
                  <View class="min-w-0 flex-1 flex-row items-center gap-2.5">
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

                {renderActiveTab()}
              </View>
            </View>
          </If>
        );
      }}
    </If>
  );
}
