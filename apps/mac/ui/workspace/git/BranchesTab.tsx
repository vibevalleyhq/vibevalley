import { computed, Text, View } from "nsh";
import { Button, Input } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import { ActiveBar } from "../../design/layout";
import { act } from "../../infra/bridge";
import { PanelEmpty, SectionHead, startEllipsis } from "../chrome";
import type { GitFrame, WorktreesSectionCtx } from "./model";
import { WorktreesSection } from "./WorktreesSection";

export function BranchesTab(props: {
  frame: GitFrame | null;
  branchQuery: string;
  onBranchQueryChange: (value: string) => void;
  switchingBranch: string | null;
  onSwitchBranch: (branch: string) => void;
  isOpen: (key: string) => boolean;
  toggleSection: (key: string) => void;
  worktreesCtx: WorktreesSectionCtx;
}) {
  const branchesCount = computed(() => props.frame?.branches?.length ?? 0);
  const filteredBranches = computed(() => {
    const q = props.branchQuery.trim().toLowerCase();
    return (props.frame?.branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));
  });

  return (
    <View>
      <View class="pb-1">
        <SectionHead
          title={t("web.shell.git.branches")}
          count={branchesCount()}
          collapsible
          expanded={props.isOpen("branches")}
          onToggle={() => props.toggleSection("branches")}
        />
        <If when={props.isOpen("branches")}>
          <View>
            <If when={branchesCount() > 6}>
              <View class="px-3 pt-0.5 pb-1.5">
                <Input
                  value={props.branchQuery}
                  onChange={({ value }) => props.onBranchQueryChange(value)}
                  placeholder={t("web.shell.git.filterBranches")}
                  class="h-6.5 rounded-md border border-line bg-elevated px-2 text-xs text-ink placeholder:text-faint hover:border-faint focus:border-focus"
                />
              </View>
            </If>
            <If when={branchesCount() > 0} else={<PanelEmpty text={t("web.shell.git.noBranches")} compact />}>
              <If when={filteredBranches().length > 0} else={<PanelEmpty text={t("web.shell.git.noMatchingBranches")} compact />}>
                <View class="gap-px">
                  <Each of={filteredBranches()} key={(b) => b.name}>
                    {(b) => (
                      <Button
                        disabled={props.switchingBranch !== null}
                        onPress={() => {
                          if (!b().head) {
                            props.onSwitchBranch(b().name);
                            act({ type: "checkout", branch: b().name });
                          }
                        }}
                        accessibilityLabel={
                          b().head ? t("web.shell.git.currentBranch", { name: b().name }) : t("web.shell.git.switchBranch", { name: b().name })
                        }
                        class={`relative mx-1.5 h-6.5 flex-row items-center gap-1.5 rounded-md px-1.5 ${
                          props.switchingBranch !== null ? "" : "active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus"
                        } ${b().head ? "bg-selected" : "bg-transparent hover:bg-hover"}`}
                      >
                        <If when={b().head}>
                          <ActiveBar />
                        </If>
                        <View class="size-3.5 shrink-0 items-center justify-center">
                          <Icon name={b().head ? "ticked" : "branch"} size={12} tone={b().head ? "leaf" : "faint"} />
                        </View>
                        <Text class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-ink">{b().name}</Text>
                        <If
                          when={props.switchingBranch === b().name}
                          else={
                            <If when={b().upstream}>
                              {(upstream) => (
                                <Text class="max-w-32 shrink-0 truncate font-mono text-2xs text-muted" style={startEllipsis}>
                                  {upstream()}
                                </Text>
                              )}
                            </If>
                          }
                        >
                          <Text class="shrink-0 text-2xs font-medium text-warn-ink">{t("web.shell.git.switching")}</Text>
                        </If>
                      </Button>
                    )}
                  </Each>
                </View>
              </If>
            </If>
          </View>
        </If>
      </View>

      <If when={props.worktreesCtx.worktreesCount() > 0}>
        <WorktreesSection sectionKey="branches-worktrees" title={t("web.shell.git.worktrees")} borderTop showNotice ctx={props.worktreesCtx} />
      </If>
    </View>
  );
}
