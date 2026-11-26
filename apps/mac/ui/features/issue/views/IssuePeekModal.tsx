import { computed, Text, View, windowSize, type JSX } from "nsh";
import { Dialog as Base } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { fadeAnimation } from "../../../design/motion";
import { type BoardCard, cardRepo } from "../model/cards";
import { StatusMark } from "./Marks";
import { createIssueChrome, IssueChromeContext, IssueNumberPill } from "./Sheet";

/** Quick-Peek modal overlay for reviewing and acting on an issue without leaving the board. */
export function IssuePeekModal(props: { card: BoardCard; blocked: () => boolean; onExpand: (id: string) => void; onClose: () => void; children: JSX.Element }) {
  const chrome = createIssueChrome();
  const repo = computed(() => cardRepo(props.card));
  const dims = computed(() => {
    const vp = windowSize();
    const width = Math.min(860, Math.max(320, Math.round(vp.width * 0.92)));
    const height = Math.min(760, Math.max(360, Math.round(vp.height * 0.82)));
    const marginTop = Math.max(24, Math.round((vp.height - height) / 2));
    return { width, height, marginTop };
  });

  return (
    <Base
      open
      testID="issue-peek-modal"
      accessibilityLabel={props.card.issue.title}
      animation={fadeAnimation()}
      onOpenChange={(e) => {
        if (!e.open && !props.blocked()) props.onClose();
      }}
      backdropClass="bg-scrim"
      class="mx-auto flex-col overflow-hidden rounded-xl border border-line bg-page shadow-float"
      style={dims()}
    >
      <IssueChromeContext.Provider value={chrome}>
        <View class="h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-side px-4">
          <View class="min-w-0 flex-1 flex-row items-center gap-2">
            <IssueNumberPill number={props.card.issue.number} />
            <If when={repo()}>
              {(r) => (
                <View class="min-w-0 shrink flex-row items-center gap-1 rounded-md border border-line bg-page px-1.5 py-0.5">
                  <Icon name="folder" size={12} tone="muted" />
                  <Text class="min-w-0 truncate text-xs font-medium text-muted">{r()}</Text>
                </View>
              )}
            </If>
            <View testID="issue-peek-status" class="shrink-0 flex-row items-center gap-1.5 rounded-full bg-hover px-2 py-0.5">
              <StatusMark status={props.card.issue.status} size={12} />
              <Text class="text-2xs font-medium text-muted">{t(`shared.status.${props.card.issue.status}`)}</Text>
            </View>
          </View>
          <View class="shrink-0 flex-row items-center gap-1.5">
            <If when={chrome.hasSheet()}>
              <IconButton
                testid="issue-peek-inspector-toggle"
                icon="sidebarRight"
                size={14}
                pressed={chrome.inspectorVisible()}
                label={t("web.issue.detail.properties")}
                onClick={() => chrome.toggleInspector()}
              />
            </If>
            <Button size="compact" tone="plain" icon="enlarge" testID="issue-peek-expand" onPress={() => props.onExpand(props.card.id)}>
              {t("web.issue.peek.expand")}
            </Button>
            <IconButton testid="issue-peek-close" icon="close" size={14} label={t("web.issue.peek.close")} onClick={() => props.onClose()} />
          </View>
        </View>
        <View class="min-h-0 flex-1">{props.children}</View>
      </IssueChromeContext.Provider>
    </Base>
  );
}
