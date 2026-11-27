import { computed, Text, View } from "nsh";
import { Button } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { motionClass } from "../../design/motion";
import { Bubble } from "../../design/Tip";
import { act } from "../../infra/bridge";
import { PanelEmpty, SectionHead } from "../chrome";
import { autoDirection, formatCommitTime, type GitFrame } from "./model";

export function CommitsTab(props: { frame: GitFrame | null; isOpen: (key: string) => boolean; toggleSection: (key: string) => void }) {
  const logCount = computed(() => props.frame?.log?.length ?? 0);

  return (
    <View>
      <SectionHead
        title={t("web.shell.git.commits")}
        count={logCount()}
        collapsible
        expanded={props.isOpen("commits")}
        onToggle={() => props.toggleSection("commits")}
        borderBottom={props.isOpen("commits") && logCount() > 0}
      />
      <If when={props.isOpen("commits")}>
        <If when={logCount() > 0} else={<PanelEmpty text={t("web.shell.git.noCommits")} compact />}>
          <Each of={props.frame?.log ?? []} key={(c) => c.id}>
            {(c) => (
              <Button
                onPress={() => act({ type: "open_commit", id: c().id })}
                accessibilityLabel={`Commit ${c().short}: ${c().summary}`}
                tooltip={<Bubble text={`${c().short} · ${c().summary}`} />}
                class={`gap-1 border-b border-line px-3 py-2 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
              >
                <View class="flex-row items-center gap-2">
                  <Text class="min-w-0 flex-1 truncate text-sm text-ink" style={autoDirection}>
                    {c().summary}
                  </Text>
                  <View class="h-4.5 min-w-17 shrink-0 items-center justify-center rounded-sm border border-line bg-elevated px-1.5">
                    <Text class="truncate font-mono text-2xs text-leaf tabular-nums">{c().short}</Text>
                  </View>
                </View>
                <View class="flex-row items-center gap-2">
                  <Text class="min-w-0 flex-1 truncate text-2xs text-muted">{c().author}</Text>
                  <Text class="shrink-0 text-right text-2xs text-faint">{formatCommitTime(c().time)}</Text>
                </View>
              </Button>
            )}
          </Each>
        </If>
      </If>
    </View>
  );
}
