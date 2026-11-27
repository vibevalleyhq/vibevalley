import { computed, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { motionClass } from "../../design/motion";
import { Bubble } from "../../design/Tip";
import { act, frame } from "../../infra/bridge";
import { FileTree, filesFrameSchema } from "../FileTree";
import { GitPanel, gitFrameSchema, type GitTab } from "../GitPanel";
import { railFrameSchema } from "./model";

export function InspectorPane() {
  const rail = frame("rail", railFrameSchema);
  const files = frame("files", filesFrameSchema);
  const git = frame("git", gitFrameSchema);
  const gitTab = signal<GitTab>("changes");

  const panel = () => rail()?.panel ?? "files";
  const showFiles = computed(() => panel() === "files");
  const showGit = computed(() => panel() === "git");
  const conflictCount = computed(() => git()?.conflicts?.length ?? 0);
  const gitCount = computed(() => (git()?.staged?.length ?? 0) + (git()?.changes?.length ?? 0) + conflictCount());
  const currentView = computed(() => (panel() === "git" ? `git:${gitTab()}` : panel()));

  const inspectorTabs: { id: string; label: string; tip: string; badge?: () => number; danger?: () => boolean; onSelect: () => void }[] = [
    { id: "files", label: t("web.shell.sidebar.files"), tip: t("web.shell.sidebar.filesTip"), onSelect: () => act({ type: "show_panel", panel: "files" }) },
    {
      id: "git:changes",
      label: t("web.shell.sidebar.gitChanges"),
      tip: t("web.shell.sidebar.gitChangesTip"),
      badge: gitCount,
      danger: () => conflictCount() > 0,
      onSelect: () => {
        gitTab.set("changes");
        if (panel() !== "git") act({ type: "show_panel", panel: "git" });
      },
    },
    {
      id: "git:branches",
      label: t("web.shell.sidebar.gitBranches"),
      tip: t("web.shell.sidebar.gitBranchesTip"),
      onSelect: () => {
        gitTab.set("branches");
        if (panel() !== "git") act({ type: "show_panel", panel: "git" });
      },
    },
    {
      id: "git:commits",
      label: t("web.shell.sidebar.gitCommits"),
      tip: t("web.shell.sidebar.gitCommitsTip"),
      onSelect: () => {
        gitTab.set("commits");
        if (panel() !== "git") act({ type: "show_panel", panel: "git" });
      },
    },
  ];

  return (
    <View testID="workspace-inspector" class="flex-1 bg-side">
      <View role="tablist" desktop={{ windowDrag: true }} class="h-9 flex-row items-center gap-0.5 border-b border-line px-2">
        <Each of={inspectorTabs} key={(item) => item.id}>
          {(item) => {
            const isCur = () => currentView() === item().id;
            const count = () => item().badge?.() ?? 0;
            const isDanger = () => Boolean(item().danger?.());
            return (
              <Button
                onPress={() => item().onSelect()}
                selected={isCur()}
                accessibilityLabel={count() > 0 ? `${item().label} (${count()})` : item().label}
                tooltip={<Bubble text={item().tip} />}
                class={`h-6 flex-row items-center justify-center gap-1 rounded-md px-2 ${motionClass("transition-opacity duration-120 ease-out")} active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus ${
                  isCur() ? "bg-selected" : "bg-transparent hover:bg-hover"
                }`}
              >
                <Text class={`text-xs font-medium ${isCur() ? "text-ink" : "text-muted"}`}>{item().label}</Text>
                <If when={count() > 0}>
                  <View class={`h-4 min-w-4 items-center justify-center rounded-full px-1 ${isDanger() ? "bg-bad-soft" : "bg-hover"}`}>
                    <Text class={`text-2xs font-semibold tabular-nums ${isDanger() ? "text-berry" : isCur() ? "text-ink" : "text-muted"}`}>
                      {String(count())}
                    </Text>
                  </View>
                </If>
              </Button>
            );
          }}
        </Each>
      </View>
      <If when={showFiles()}>
        <FileTree frame={files()} />
      </If>
      <If when={showGit()}>
        <GitPanel frame={git()} tab={gitTab()} />
      </If>
    </View>
  );
}
