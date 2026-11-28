import { computed, Text, View } from "nsh";

import { list, t } from "@vibevalley/i18n";
import type { BacklogTriageSuggestion, MorningDigest, RepoHealthStatus } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Quiet } from "../../design/layout";
import { CountPill } from "../../design/Tag";
import { toast } from "../../design/toasts";
import { createAct } from "../../infra/act";
import { api } from "../../infra/api";
import { useRefreshSlice } from "../../infra/frame";
import { defineQuery, ready, retryRead, useQuery, useQueryClient } from "../../infra/query";
import { Link as A } from "../../infra/router";

const morningDigestQuery = defineQuery({
  key: () => ["issue-digest"],
  fetch: (_, context) => api.issue.digest.get({}, context),
  ...retryRead,
});

const backlogTriageQuery = defineQuery({
  key: () => ["issue-triage"],
  fetch: (_, context) => api.issue.triage.list(context),
  ...retryRead,
});

function healthToneClasses(status: RepoHealthStatus): { readonly box: string; readonly ink: string } {
  switch (status) {
    case "on_track":
      return { box: "bg-ok-soft", ink: "text-ok-ink" };
    case "at_risk":
      return { box: "bg-warn-soft", ink: "text-warn-ink" };
    case "off_track":
      return { box: "bg-bad-soft", ink: "text-berry" };
  }
}

function TriageSuggestionList(props: { suggestions: readonly BacklogTriageSuggestion[]; onChanged?: () => void }) {
  const act = createAct();
  const client = useQueryClient();
  const refreshBoard = useRefreshSlice("board");

  const confirm = async (id: string) => {
    const ok = await act.run(async () => {
      await api.issue.triage.confirm({ id });
      await client.invalidate({ prefix: ["issue-digest"] });
      await client.invalidate({ prefix: ["issue-triage"] });
      refreshBoard();
      return true;
    });
    if (ok === true) {
      toast(t("web.issue.digest.triageConfirm"));
      props.onChanged?.();
    }
  };

  const dismiss = async (id: string) => {
    await act.run(async () => {
      await api.issue.triage.dismiss({ id });
      await client.invalidate({ prefix: ["issue-digest"] });
      await client.invalidate({ prefix: ["issue-triage"] });
      return true;
    });
    props.onChanged?.();
  };

  return (
    <If when={props.suggestions.length > 0} else={<Quiet>{t("web.issue.digest.triageEmpty")}</Quiet>}>
      <View class="gap-2">
        <Each of={props.suggestions} key={(s) => s.id}>
          {(s) => (
            <View
              testID={`triage-item-${s().id}`}
              class="flex-row flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-page px-3 py-2.5"
            >
              <View class="min-w-0 flex-1 gap-0.5">
                <A href={`/issues/${encodeURIComponent(s().issueId)}`} class="text-sm font-medium text-ink hover:underline">
                  {`#${s().issueNumber} ${s().issueTitle}`}
                </A>
                <Text class="text-xs font-medium text-water">{s().summary}</Text>
                <Text class="text-xs text-muted">{s().reason}</Text>
              </View>
              <View class="shrink-0 flex-row items-center gap-1.5">
                <Button size="compact" tone="primary" testID={`triage-confirm-${s().id}`} disabled={act.busy()} onPress={() => void confirm(s().id)}>
                  {t("web.issue.digest.triageConfirm")}
                </Button>
                <Button size="compact" tone="quiet" testID={`triage-dismiss-${s().id}`} disabled={act.busy()} onPress={() => void dismiss(s().id)}>
                  {t("web.issue.digest.triageDismiss")}
                </Button>
              </View>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}

/** Three-part Morning Digest card rendered on DashboardOverview. */
export function MorningDigestPanel() {
  const query = useQuery(() => morningDigestQuery());
  const digest = computed<MorningDigest | undefined>(() => ready(query, undefined));

  return (
    <View testID="dashboard-morning-digest" class="rounded-xl border border-line bg-elevated">
      <View class="flex-row flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <View class="min-w-0 flex-1 gap-0.5">
          <View class="flex-row items-center gap-2">
            <Text class="text-xs font-semibold text-muted">{t("web.issue.digest.title")}</Text>
            <If when={(digest()?.triage.length ?? 0) > 0}>
              <CountPill count={digest()?.triage.length ?? 0} />
            </If>
          </View>
          <Text class="text-xs text-faint">{t("web.issue.digest.subtitle")}</Text>
        </View>
        <Button size="compact" tone="quiet" testID="digest-refresh" disabled={query.fetching()} onPress={() => void query.refetch()}>
          {t("web.issue.digest.refresh")}
        </Button>
      </View>

      <If when={digest()}>
        {(d) => {
          const p = () => d().progress;
          const attentionItems = computed(() => [...p().asking, ...p().stuck, ...p().reviewing].slice(0, 6));
          const hasProgress = () =>
            p().asking.length > 0 ||
            p().reviewing.length > 0 ||
            p().stuck.length > 0 ||
            p().working.length > 0 ||
            p().completedRecent.length > 0 ||
            p().runsTotal > 0;
          return (
            <View class="gap-4 p-4">
              <View testID="digest-part-progress" class="gap-1.5">
                <Text class="text-xs font-semibold text-ink">{t("web.issue.digest.progressTitle")}</Text>
                <If when={hasProgress()} else={<Quiet>{t("web.issue.digest.quiet")}</Quiet>}>
                  <Text class="text-xs text-muted tabular-nums">
                    {t("web.issue.digest.runsLine", {
                      total: p().runsTotal,
                      completed: p().runsCompleted,
                      failed: p().runsFailed,
                      interrupted: p().runsInterrupted,
                    })}
                  </Text>
                  <If when={attentionItems().length > 0}>
                    <View class="gap-1 pt-1">
                      <Each of={attentionItems()} key={(item) => item.id}>
                        {(item) => (
                          <A href={`/issues/${encodeURIComponent(item().id)}`} class="text-xs text-water hover:underline">
                            {`#${item().number} ${item().title}${item().detail ? ` · ${item().detail}` : ""}`}
                          </A>
                        )}
                      </Each>
                    </View>
                  </If>
                </If>
              </View>

              <View testID="digest-part-health" class="gap-1.5 border-t border-line pt-3">
                <Text class="text-xs font-semibold text-ink">{t("web.issue.digest.healthTitle")}</Text>
                <If when={d().repoHealth.length > 0} else={<Quiet>{t("web.issue.digest.emptyHealth")}</Quiet>}>
                  <View testID="digest-health-list">
                    <Each of={d().repoHealth} key={(h) => h.repo}>
                      {(h, i) => {
                        const tone = () => healthToneClasses(h().status);
                        return (
                          <View class={i() > 0 ? "border-t border-line" : ""}>
                            <A
                              href={`/repos/${encodeURIComponent(h().repo)}`}
                              class="-mx-2 flex-row flex-wrap items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-hover"
                            >
                              <View class="min-w-0 flex-1 flex-row items-center gap-2">
                                <Text class="text-sm font-medium text-ink">{h().repo}</Text>
                                <View class={`rounded-sm px-1.5 py-0.5 ${tone().box}`}>
                                  <Text class={`text-2xs font-medium ${tone().ink}`}>{t(`shared.repoHealth.${h().status}`)}</Text>
                                </View>
                              </View>
                              <If when={h().status !== "on_track" && h().reasons.length > 0}>
                                <Text class="truncate text-xs text-muted">{list(h().reasons.map((r) => t(`shared.repoHealthReason.${r}`)))}</Text>
                              </If>
                            </A>
                          </View>
                        );
                      }}
                    </Each>
                  </View>
                </If>
              </View>

              <View testID="digest-part-triage" class="gap-1.5 border-t border-line pt-3">
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="text-xs font-semibold text-ink">{t("web.issue.digest.triageTitle")}</Text>
                  <If when={d().triage.length > 0}>
                    <Text class="text-xs text-muted">{t("web.issue.digest.pendingCount", { n: d().triage.length })}</Text>
                  </If>
                </View>
                <TriageSuggestionList suggestions={d().triage} />
              </View>
            </View>
          );
        }}
      </If>
    </View>
  );
}

/** Inline confirmable backlog triage strip shown on the Backlog scope of IssuesPage. */
export function BacklogTriagePanel() {
  const query = useQuery(() => backlogTriageQuery());
  const items = computed(() => ready(query, []));
  return (
    <If when={items().length > 0}>
      <View testID="backlog-triage-panel" class="mx-3 mt-2 gap-2 rounded-xl border border-line bg-elevated p-3">
        <View class="flex-row items-center justify-between gap-2">
          <Text class="text-xs font-semibold text-ink">{t("web.issue.digest.triageTitle")}</Text>
          <Text class="text-xs text-muted">{t("web.issue.digest.pendingCount", { n: items().length })}</Text>
        </View>
        <TriageSuggestionList suggestions={items()} />
      </View>
    </If>
  );
}
