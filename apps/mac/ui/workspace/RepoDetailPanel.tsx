import { cleanup, Clipboard, computed, effect, host, keymap, Scroll, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { RepoActivity as RepoActivityData, RepoLanguages as RepoLanguagesData } from "@vibevalley/protocol";
import { RepoActivity, RepoLanguages } from "@vibevalley/protocol/schema";

import { Icon } from "../design/Icon";
import { motionClass } from "../design/motion";
import { Bubble } from "../design/Tip";
import { mix } from "../design/tone";
import { act, callDecoded, hostApi } from "../infra/bridge";
import { languageShares, number as formatNumber, percent as formatPercent } from "../infra/repos";
import { ShellIconButton, startEllipsis } from "./chrome";

export interface RepoDetailWorktree {
  readonly id: string;
  readonly label: string;
  readonly branch?: string | null;
  readonly path: string;
  readonly isMain: boolean;
  readonly active: boolean;
  readonly sessionRunning: boolean;
  readonly tabsCount: number;
}

export interface RepoDetailTarget {
  readonly projectId?: number;
  readonly name: string;
  readonly path: string;
  readonly branch?: string | null;
  readonly active: boolean;
  readonly vibevalley: boolean;
  readonly external?: boolean;
  readonly git?: boolean;
  readonly maxSessions?: number;
  readonly pullRequest?: { readonly available: boolean; readonly reason: string };
  readonly openIssues: number;
  readonly activeSessions: number;
  readonly totalTabs: number;
  readonly worktrees: readonly RepoDetailWorktree[];
}

function MetaRow(props: { label: string; value: string; mono?: boolean; toneClass?: string; tip?: string }) {
  const valueText = () => (
    <Text class={`truncate text-xs font-medium tabular-nums ${props.mono === true ? "font-mono" : ""} ${props.toneClass ?? "text-ink"}`}>{props.value}</Text>
  );
  return (
    <View class="flex-row items-center justify-between gap-2 py-0.5">
      <Text class="shrink-0 text-2xs text-muted">{props.label}</Text>
      <If when={props.tip} else={<View class="min-w-0 shrink">{valueText()}</View>}>
        {(tip) => (
          <View class="min-w-0 shrink" tooltip={<Bubble text={tip()} />}>
            {valueText()}
          </View>
        )}
      </If>
    </View>
  );
}

export function RepoDetailPanel(props: { repo: RepoDetailTarget; onClose: () => void }) {
  const copied = signal(false);
  const activity = signal<RepoActivityData | null>(null);
  const languages = signal<RepoLanguagesData | null>(null);

  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let loadedRepoName: string | null = null;
  let fetchSeq = 0;

  keymap.bind("escape", () => props.onClose(), { when: "always" });

  cleanup(() => {
    fetchSeq += 1;
    if (copyTimer !== undefined) clearTimeout(copyTimer);
  });

  effect(() => {
    const repoName = props.repo.vibevalley ? props.repo.name : null;
    if (repoName === loadedRepoName) return;
    loadedRepoName = repoName;
    const seq = ++fetchSeq;
    activity.set(null);
    languages.set(null);
    if (!repoName || !host.available()) return;

    void callDecoded("repo.activity.get", { id: repoName }, RepoActivity).then((env) => {
      if (fetchSeq === seq && env.bizCode === 0 && env.data) activity.set(env.data);
    });
    void callDecoded("repo.language.list", { id: repoName }, RepoLanguages).then((env) => {
      if (fetchSeq === seq && env.bizCode === 0 && env.data) languages.set(env.data);
    });
  });

  const isGit = computed(() => props.repo.git === true || Boolean(props.repo.branch) || props.repo.worktrees.length > 1);

  const topLanguages = computed(() => languageShares(languages()?.languages ?? [], 4));

  const copyPath = () => {
    void Clipboard.writeText(props.repo.path).then(
      () => {
        copied.set(true);
        if (copyTimer !== undefined) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => copied.set(false), 1500);
      },
      () => undefined,
    );
  };

  return (
    <View testID="workspace-repo-detail" class="flex-1 bg-side">
      <View desktop={{ windowDrag: true }} class="h-9 flex-row items-center justify-between gap-1.5 border-b border-line pr-2 pl-2">
        <View class="min-w-0 flex-1 flex-row items-center gap-1">
          <Button
            testID="repo-detail-back"
            onPress={() => props.onClose()}
            accessibilityLabel={t("web.shell.sidebar.backToRepos")}
            tooltip={<Bubble text={t("web.shell.sidebar.backToRepos")} />}
            class={`size-6 shrink-0 items-center justify-center rounded-md ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Icon name="back" size={13} tone="muted" />
          </Button>
          <Text role="header" class="truncate text-xs font-semibold text-ink">
            {t("web.shell.sidebar.repoDetails")}
          </Text>
        </View>
        <If when={props.repo.vibevalley}>
          <ShellIconButton
            icon="open"
            size={13}
            label={t("web.shell.repoDetail.openFullPage")}
            onPress={() => act({ type: "open_route", path: `/repos/${encodeURIComponent(props.repo.name)}` })}
          />
        </If>
      </View>

      <Scroll class="flex-1" contentClass="gap-3 p-3">
        <View class="gap-2.5">
          <View class="flex-row items-center gap-2.5">
            <View class="size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-elevated">
              <Icon name={props.repo.vibevalley ? "repos" : "folder"} size={16} tone={props.repo.active ? "leaf" : "muted"} />
            </View>
            <View class="min-w-0 flex-1 gap-0.5">
              <Text testID="repo-detail-name" class="truncate text-sm font-semibold text-ink">
                {props.repo.name}
              </Text>
              <View class="flex-row items-center gap-1.5">
                <View class={`rounded-sm px-1.5 py-px ${props.repo.vibevalley ? "bg-ok-soft" : "bg-hover"}`}>
                  <Text class={`text-2xs font-medium ${props.repo.vibevalley ? "text-ok-ink" : "text-muted"}`}>
                    {props.repo.vibevalley
                      ? props.repo.external === true
                        ? t("web.shell.repoDetail.badgeMounted")
                        : t("web.shell.repoDetail.badgeManaged")
                      : t("web.shell.repoDetail.badgeFolder")}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          <View class="flex-row items-center gap-1 rounded-md border border-line bg-page px-2 py-1">
            <View class="min-w-0 flex-1" tooltip={<Bubble text={props.repo.path} />}>
              <Text testID="repo-detail-path" class="truncate font-mono text-2xs text-muted" style={startEllipsis}>
                {props.repo.path}
              </Text>
            </View>
            <Button
              testID="repo-detail-copy-path"
              onPress={copyPath}
              accessibilityLabel={copied() ? t("web.shell.repoDetail.copied") : t("web.shell.sidebar.copyPath")}
              tooltip={<Bubble text={copied() ? t("web.shell.repoDetail.copied") : t("web.shell.sidebar.copyPath")} />}
              class={`size-5 shrink-0 items-center justify-center rounded-sm ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
            >
              <Icon name={copied() ? "check" : "copy"} size={12} tone={copied() ? "leaf" : "muted"} />
            </Button>
            <Button
              testID="repo-detail-reveal"
              onPress={() => void hostApi.reveal(props.repo.path)}
              accessibilityLabel={t("web.shell.sidebar.revealInFinder")}
              tooltip={<Bubble text={t("web.shell.sidebar.revealInFinder")} />}
              class={`size-5 shrink-0 items-center justify-center rounded-sm ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
            >
              <Icon name="folder" size={12} tone="muted" />
            </Button>
          </View>

          <View class="flex-row items-center gap-1.5">
            <Button
              testID="repo-detail-new-chat"
              onPress={() => act({ type: "new_chat_at", path: props.repo.path })}
              class={`h-7 flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-line bg-elevated px-2 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
            >
              <Icon name="chat" size={12} tone="ink" />
              <Text class="truncate text-xs font-medium text-ink">{t("web.shell.repoDetail.newChat")}</Text>
            </Button>
            <Button
              testID="repo-detail-new-terminal"
              onPress={() => act({ type: "new_terminal_at", path: props.repo.path })}
              class={`h-7 flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-line bg-elevated px-2 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
            >
              <Icon name="terminal" size={12} tone="ink" />
              <Text class="truncate text-xs font-medium text-ink">{t("web.shell.repoDetail.newTerminal")}</Text>
            </Button>
          </View>
        </View>

        <View class="gap-1.5 rounded-lg border border-line bg-elevated p-2.5">
          <Text class="text-2xs font-semibold tracking-wide text-muted">{t("web.shell.repoDetail.sectionOverview")}</Text>
          <View class="gap-1">
            <If when={props.repo.branch}>{(branch) => <MetaRow label={t("web.shell.repoDetail.branch")} value={branch()} mono />}</If>
            <MetaRow label={t("web.shell.repoDetail.repoType")} value={isGit() ? t("web.shell.repoDetail.typeGit") : t("web.shell.repoDetail.typeFolder")} />
            <MetaRow
              label={t("web.shell.repoDetail.activity")}
              value={t("web.shell.repoDetail.activitySummary", { worktrees: props.repo.worktrees.length, tabs: props.repo.totalTabs })}
            />
            <If when={props.repo.vibevalley && props.repo.openIssues > 0}>
              <MetaRow label={t("web.shell.repoDetail.openIssues")} value={String(props.repo.openIssues)} />
            </If>
            <If when={props.repo.activeSessions > 0}>
              <MetaRow label={t("web.shell.repoDetail.runningSessions")} value={String(props.repo.activeSessions)} toneClass="text-leaf" />
            </If>
            <If when={props.repo.maxSessions !== undefined}>
              <MetaRow label={t("web.shell.repoDetail.maxSessions")} value={String(props.repo.maxSessions)} />
            </If>
            <If when={props.repo.pullRequest}>
              {(pr) => (
                <MetaRow
                  label={t("web.shell.repoDetail.pullRequest")}
                  value={pr().available ? t("web.shell.repoDetail.prReady") : t("web.shell.repoDetail.prUnavailable")}
                  toneClass={pr().available ? "text-leaf" : "text-muted"}
                  tip={pr().reason || undefined}
                />
              )}
            </If>
            <If when={activity()}>{(actData) => <MetaRow label={t("web.shell.repoDetail.commits")} value={formatNumber(actData().total)} />}</If>
          </View>
        </View>

        <If when={topLanguages().length > 0}>
          <View testID="repo-detail-languages" class="gap-2 rounded-lg border border-line bg-elevated p-2.5">
            <Text class="text-2xs font-semibold tracking-wide text-muted">{t("web.shell.repoDetail.languages")}</Text>
            <View class="h-1.5 flex-row gap-px overflow-hidden rounded-full bg-hover">
              <Each of={topLanguages()} key={(lang) => lang.label}>
                {(lang) => (
                  <View class="h-full" style={{ flexGrow: Math.max(1, Math.round(lang().share * 1000)), flexBasis: 0, backgroundColor: lang().color }} />
                )}
              </Each>
            </View>
            <View class="gap-1">
              <Each of={topLanguages()} key={(lang) => lang.label}>
                {(lang) => (
                  <View class="flex-row items-center justify-between gap-2">
                    <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                      <View class="size-2 shrink-0 rounded-full" style={{ backgroundColor: lang().color }} />
                      <Text class="truncate text-xs text-ink">{lang().label}</Text>
                    </View>
                    <Text class="shrink-0 font-mono text-2xs text-muted tabular-nums">{formatPercent(lang().share)}</Text>
                  </View>
                )}
              </Each>
            </View>
          </View>
        </If>

        <View class="gap-1.5">
          <View class="flex-row items-center justify-between px-0.5">
            <Text class="text-2xs font-semibold tracking-wide text-muted">{t("web.shell.repoDetail.worktrees")}</Text>
            <View class="h-4 min-w-4.5 items-center justify-center rounded-full bg-hover px-1.5">
              <Text class="font-mono text-2xs font-medium text-muted tabular-nums">{String(props.repo.worktrees.length)}</Text>
            </View>
          </View>
          <View class="gap-0.5">
            <Each of={props.repo.worktrees} key={(wt) => wt.path}>
              {(wt) => (
                <Button
                  testID={`repo-detail-worktree-${wt().isMain ? "main" : wt().label}`}
                  onPress={() => act({ type: "activate_path", path: wt().path })}
                  tooltip={<Bubble text={wt().path} />}
                  class={`h-7.5 flex-row items-center gap-1.5 rounded-md px-2 ${motionClass("transition-opacity duration-120 ease-out")} ${
                    wt().active ? "bg-selected" : "hover:bg-hover"
                  } active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
                >
                  <Icon name="branch" size={12} tone={wt().sessionRunning ? "leaf" : wt().active ? "ink" : "muted"} />
                  <View class="min-w-0 flex-1 flex-row items-center gap-1">
                    <Text class="shrink truncate text-xs font-medium text-ink">{wt().label}</Text>
                    <If when={wt().isMain}>
                      <Text class="shrink-0 text-2xs text-faint">{t("web.shell.sidebar.mainLabel")}</Text>
                    </If>
                  </View>
                  <View class="shrink-0 flex-row items-center gap-1">
                    <If when={wt().sessionRunning}>
                      <View class="size-1.5 rounded-full bg-leaf" />
                    </If>
                    <If when={wt().tabsCount > 0}>
                      <Text class="text-2xs text-muted tabular-nums">{t("web.shell.repoDetail.tabsCount", { n: wt().tabsCount })}</Text>
                    </If>
                  </View>
                </Button>
              )}
            </Each>
          </View>
        </View>
      </Scroll>

      <If when={props.repo.vibevalley || props.repo.projectId !== undefined}>
        <View class="border-t border-line p-2.5">
          <If
            when={props.repo.vibevalley}
            else={
              <Button
                testID="repo-detail-close-folder"
                onPress={() => {
                  const id = props.repo.projectId;
                  props.onClose();
                  if (id !== undefined) act({ type: "close_project", id });
                }}
                class={`h-7.5 flex-row items-center justify-center gap-1.5 rounded-md border px-2.5 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-bad-soft active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
                style={{ borderColor: mix("berry", 0.3) }}
              >
                <Icon name="close" size={12} tone="berry" />
                <Text class="text-xs font-medium text-berry">{t("web.shell.repoDetail.closeFolder")}</Text>
              </Button>
            }
          >
            <Button
              testID="repo-detail-open-full"
              onPress={() => act({ type: "open_route", path: `/repos/${encodeURIComponent(props.repo.name)}` })}
              class={`h-7.5 flex-row items-center justify-center gap-1.5 rounded-md border border-line bg-elevated px-2.5 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
            >
              <Icon name="repos" size={12} tone="ink" />
              <Text class="text-xs font-medium text-ink">{t("web.shell.repoDetail.openFullPage")}</Text>
            </Button>
          </If>
        </View>
      </If>
    </View>
  );
}
