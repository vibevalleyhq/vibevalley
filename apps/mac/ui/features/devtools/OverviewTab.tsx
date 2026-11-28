import { Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DebugGraph, DebugOverview } from "@vibevalley/protocol";

import { Tag } from "../../design/Tag";
import { formatDurationMs, formatFrameMs, trajectoryKindLabel, trajectoryKindTone } from "./format";
import { MetricTile, SectionHeader } from "./shared";

export function OverviewTab(props: { overview: () => DebugOverview; graph: () => DebugGraph }) {
  const o = () => props.overview();
  const g = () => props.graph();
  return (
    <Scroll testID="devtools-overview" class="min-h-0 flex-1" contentClass="gap-4 p-3">
      <View class="gap-2">
        <View class="flex-row flex-wrap gap-2">
          <MetricTile label={t("web.devtools.overview.channel")} value={o().channel} testID="overview-channel" />
          <MetricTile label={t("web.devtools.overview.version")} value={o().version} />
          <MetricTile label={t("web.devtools.overview.bundleMode")} value={o().bundleMode ?? "—"} />
          <MetricTile label={t("web.devtools.overview.bootTime")} value={formatDurationMs(o().bootMs)} />
          <MetricTile label={t("web.devtools.overview.latestSeq")} value={String(o().latestSeq)} testID="overview-seq" />
          <MetricTile label={t("web.devtools.overview.lastFrameMs")} value={formatFrameMs(o().lastFrameMs)} />
        </View>
        <View class="flex-row flex-wrap gap-2">
          <MetricTile label={t("web.devtools.overview.activeSessions")} value={String(o().activeSessions)} />
          <MetricTile label={t("web.devtools.overview.activeClients")} value={String(o().activeClients)} />
          <MetricTile label={t("web.devtools.overview.activeSubscriptions")} value={String(o().activeSubscriptions)} />
          <MetricTile label={t("web.devtools.overview.loopbackUrl")} value={o().loopbackUrl ?? "—"} />
        </View>
        <View class="gap-1.5 rounded-md border border-line bg-page p-2.5">
          <PathLine label={t("web.devtools.overview.homePath")} value={o().homePath} />
          <PathLine label={t("web.devtools.overview.workRoot")} value={o().workRoot} />
          <PathLine label={t("web.devtools.overview.dbPath")} value={o().dbPath} />
        </View>
      </View>

      <View class="gap-2">
        <SectionHeader title={t("web.devtools.overview.runtimes")} count={o().runtimes.length} />
        <If
          when={o().runtimes.length > 0}
          else={
            <View class="rounded-md border border-line bg-side px-3 py-2.5">
              <Text class="text-xs text-muted">{t("web.devtools.status.empty")}</Text>
            </View>
          }
        >
          <View class="overflow-hidden rounded-md border border-line bg-page">
            <Each of={o().runtimes} key={(r) => r.id}>
              {(rt, idx) => (
                <View class={`flex-row items-center gap-2 px-3 py-2 ${idx() > 0 ? "border-t border-line" : ""}`}>
                  <View class="min-w-0 flex-1 flex-row items-center gap-2">
                    <Text class="truncate text-xs font-medium text-ink">{rt().name}</Text>
                    <Text class="font-mono text-2xs text-faint">{rt().id}</Text>
                    <If when={Boolean(rt().version)}>
                      <Text class="font-mono text-2xs text-muted">{rt().version}</Text>
                    </If>
                  </View>
                  <Tag
                    tone={rt().installed ? "ok" : "neutral"}
                    label={rt().installed ? t("web.devtools.overview.installed") : t("web.devtools.overview.notInstalled")}
                  />
                  <Tag tone={rt().ready ? "ok" : "wait"} label={rt().ready ? t("web.devtools.overview.ready") : t("web.devtools.overview.notReady")} />
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>

      <View testID="overview-graph" class="gap-2.5">
        <SectionHeader title={t("web.devtools.overview.graph")} />
        <View class="gap-2 md:flex-row">
          <View class="min-w-0 flex-1 gap-1.5 rounded-md border border-line bg-page p-2.5">
            <SectionHeader title={t("web.devtools.overview.clients")} count={g().clients.length} />
            <If when={g().clients.length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.status.empty")}</Text>}>
              <View class="gap-1.5">
                <Each of={g().clients} key={(c) => c.id}>
                  {(client) => (
                    <View class="gap-1 rounded-sm border border-line bg-side px-2.5 py-2">
                      <View class="flex-row items-center justify-between gap-2">
                        <Text class="truncate text-xs font-medium text-ink">{client().label}</Text>
                        <Tag tone="info" label={client().kind} />
                      </View>
                      <Text class="truncate font-mono text-2xs text-faint">{client().id}</Text>
                      <If when={client().watches.length > 0}>
                        <View class="flex-row flex-wrap items-center gap-1">
                          <Text class="text-2xs text-muted">{t("web.devtools.overview.watches")}:</Text>
                          <Each of={client().watches}>
                            {(w) => (
                              <View class="rounded-xs bg-hover px-1.5 py-px">
                                <Text class="font-mono text-2xs text-ink">{w()}</Text>
                              </View>
                            )}
                          </Each>
                        </View>
                      </If>
                      <If when={client().subscriptions.length > 0}>
                        <View class="flex-row flex-wrap items-center gap-1">
                          <Text class="text-2xs text-muted">{t("web.devtools.overview.subscriptions")}:</Text>
                          <Each of={client().subscriptions}>
                            {(sub) => (
                              <View class="rounded-xs bg-hover px-1.5 py-px">
                                <Text class="font-mono text-2xs text-ink">{sub()}</Text>
                              </View>
                            )}
                          </Each>
                        </View>
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>

          <View class="min-w-0 flex-1 gap-1.5 rounded-md border border-line bg-page p-2.5">
            <SectionHeader title={t("web.devtools.overview.sessions")} count={g().sessions.length} />
            <If when={g().sessions.length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.status.empty")}</Text>}>
              <View class="gap-1.5">
                <Each of={g().sessions} key={(s) => s.sessionId}>
                  {(sess) => (
                    <View class="gap-1 rounded-sm border border-line bg-side px-2.5 py-2">
                      <View class="flex-row items-center justify-between gap-1.5">
                        <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{sess().title}</Text>
                        <Tag tone={trajectoryKindTone(sess().kind)} label={trajectoryKindLabel(sess().kind)} />
                      </View>
                      <View class="flex-row flex-wrap items-center gap-1.5">
                        <Text class="font-mono text-2xs text-muted">{sess().runtime}</Text>
                        <Tag tone="neutral" label={sess().status} />
                        <If when={sess().issueId !== undefined}>
                          <Text class="font-mono text-2xs text-faint">#{sess().issueId}</Text>
                        </If>
                      </View>
                      <If when={Boolean(sess().cwd)}>
                        <Text class="truncate font-mono text-2xs text-faint">{sess().cwd}</Text>
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>
        </View>
      </View>
    </Scroll>
  );
}

function PathLine(props: { label: string; value: string }) {
  return (
    <View class="flex-row items-center gap-2">
      <Text class="w-24 shrink-0 text-2xs font-medium text-muted">{props.label}</Text>
      <Text class="min-w-0 flex-1 truncate font-mono text-2xs text-ink">{props.value}</Text>
    </View>
  );
}
