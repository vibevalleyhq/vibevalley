import { Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { motionClass } from "../../../design/motion";
import { Tag } from "../../../design/Tag";
import { ready, useRepos, useRuntimes } from "../../../infra/query";
import { computeOnboardingReadiness, starterTemplates } from "../model/onboarding";
import type { NewIssueAt } from "./NewIssue";

function StepBadge(props: { number: number; done: boolean; testID: string }) {
  return (
    <If
      when={props.done}
      else={
        <View class="h-6 w-6 shrink-0 items-center justify-center rounded-full bg-selected">
          <Text class="text-xs font-semibold text-ink tabular-nums">{String(props.number)}</Text>
        </View>
      }
    >
      <View testID={props.testID} class="h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ok-soft">
        <Icon name="check" size={13} />
      </View>
    </If>
  );
}

export function BoardOnboarding(props: { issueCount: number; onNavigate: (path: string) => void; onNew: (where: NewIssueAt) => void }) {
  const repoQuery = useRepos();
  const runtimeQuery = useRuntimes();
  const readiness = () =>
    computeOnboardingReadiness({
      repos: ready(repoQuery, []),
      runtimes: ready(runtimeQuery, []),
      issueCount: props.issueCount,
    });
  const progressPercent = () => Math.round((readiness().completedCount / readiness().totalCount) * 100);

  return (
    <Scroll testID="issues-empty-onboarding" class="min-h-0 flex-1">
      <View class="mx-auto my-6 w-full max-w-176 px-6">
        <View class="rounded-xl border border-line bg-page p-6">
          <View class="flex-row items-start justify-between gap-3">
            <View class="min-w-0 flex-1">
              <Text role="header" class="text-lg font-semibold text-ink">
                {t("web.issue.onboarding.title")}
              </Text>
              <Text class="mt-1 text-sm text-muted">{t("web.issue.onboarding.subtitle")}</Text>
            </View>
            <View testID="onboarding-progress" class="shrink-0 pt-0.5">
              <Tag
                tone={readiness().completedCount >= 2 ? "ok" : "neutral"}
                label={t("web.issue.onboarding.progress", { done: readiness().completedCount, total: readiness().totalCount })}
              />
            </View>
          </View>
          <View class="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-side">
            <View class="h-full rounded-full bg-leaf" style={{ width: `${progressPercent()}%` }} />
          </View>
          <View class="mt-5 gap-2.5">
            <View
              testID="onboarding-step-repos"
              accessibilityState={{ checked: readiness().reposReady }}
              class="flex-row items-center gap-3 rounded-lg bg-side p-3.5"
            >
              <StepBadge number={1} done={readiness().reposReady} testID="onboarding-step-done-repos" />
              <View class="min-w-0 flex-1">
                <View class="flex-row flex-wrap items-center gap-2">
                  <Text class="text-sm font-medium text-ink">{t("web.issue.onboarding.step1Title")}</Text>
                  <If when={readiness().reposReady}>
                    <Tag tone="ok" label={t("web.issue.onboarding.step1Ready", { n: readiness().repoCount })} />
                  </If>
                </View>
                <Text class="mt-0.5 text-xs text-muted">{t("web.issue.onboarding.step1Desc")}</Text>
              </View>
              <Button tone={readiness().reposReady ? "quiet" : "plain"} icon="repos" testID="onboarding-repos" onPress={() => props.onNavigate("/repos")}>
                {readiness().reposReady ? t("web.issue.onboarding.step1Manage") : t("web.issue.onboarding.step1Action")}
              </Button>
            </View>
            <View
              testID="onboarding-step-runtimes"
              accessibilityState={{ checked: readiness().runtimesReady }}
              class="flex-row items-center gap-3 rounded-lg bg-side p-3.5"
            >
              <StepBadge number={2} done={readiness().runtimesReady} testID="onboarding-step-done-runtimes" />
              <View class="min-w-0 flex-1">
                <View class="flex-row flex-wrap items-center gap-2">
                  <Text class="text-sm font-medium text-ink">{t("web.issue.onboarding.step2Title")}</Text>
                  <If when={readiness().runtimesReady}>
                    <Tag tone="ok" label={t("web.issue.onboarding.step2Ready", { n: readiness().readyRuntimeCount })} />
                  </If>
                </View>
                <Text class="mt-0.5 text-xs text-muted">{t("web.issue.onboarding.step2Desc")}</Text>
              </View>
              <Button
                tone={readiness().runtimesReady ? "quiet" : "plain"}
                icon="runtimes"
                testID="onboarding-runtimes"
                onPress={() => props.onNavigate("/runtimes")}
              >
                {readiness().runtimesReady ? t("web.issue.onboarding.step2Manage") : t("web.issue.onboarding.step2Action")}
              </Button>
            </View>
            <View
              testID="onboarding-step-start"
              accessibilityState={{ checked: readiness().issuesReady }}
              class="flex-row items-start gap-3 rounded-lg bg-side p-3.5"
            >
              <View class="mt-0.5 shrink-0">
                <StepBadge number={3} done={readiness().issuesReady} testID="onboarding-step-done-start" />
              </View>
              <View class="min-w-0 flex-1">
                <View class="flex-row flex-wrap items-center gap-2">
                  <Text class="text-sm font-medium text-ink">{t("web.issue.onboarding.step3Title")}</Text>
                  <If when={readiness().issuesReady}>
                    <Tag tone="ok" label={t("web.issue.onboarding.step3Ready", { n: readiness().issueCount })} />
                  </If>
                </View>
                <Text class="mt-0.5 text-xs text-muted">{t("web.issue.onboarding.step3Desc")}</Text>
                <View class="mt-2.5 flex-row flex-wrap items-center gap-2">
                  <Button tone="primary" icon="add" testID="onboarding-new-issue" onPress={() => props.onNew({})}>
                    {t("web.issue.onboarding.newIssue")}
                  </Button>
                  <Button icon="chat" testID="onboarding-chat" onPress={() => props.onNavigate("/chat")}>
                    {t("web.issue.onboarding.openChat")}
                  </Button>
                </View>
                <View class="mt-3.5 border-t border-line pt-3">
                  <Text class="text-xs font-medium text-muted">{t("web.issue.onboarding.templatesTitle")}</Text>
                  <View class="mt-2 flex-row flex-wrap gap-2">
                    <Each of={starterTemplates} key={(tpl) => tpl.id}>
                      {(tpl) => (
                        <View
                          role="button"
                          testID={`onboarding-template-${tpl().id}`}
                          accessibilityLabel={t(tpl().titleKey)}
                          onPress={() => props.onNew({ text: t(tpl().promptKey) })}
                          class={`min-w-40 flex-1 rounded-md border border-line bg-elevated px-3 py-2.5 ${motionClass("transition-transform duration-120 ease-out")} hover:border-faint hover:shadow-raise active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
                        >
                          <View class="flex-row items-center gap-1.5">
                            <Icon name={tpl().icon} size={13} tone="muted" />
                            <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{t(tpl().titleKey)}</Text>
                          </View>
                          <Text class="mt-1 line-clamp-2 text-2xs leading-snug text-muted">{t(tpl().descKey)}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </View>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Scroll>
  );
}
