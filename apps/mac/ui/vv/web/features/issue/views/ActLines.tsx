// Ported from VibeValley apps/web/src/features/issue/views/ActLines.tsx.
import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { useIntents } from "../../../state/intent";
import { Icon } from "../../../ui/Icon";
import { IconButton } from "../../../ui/IconButton";
import { mix } from "../../../ui/tone";
import { issueMove, issueMoveOf } from "../model/moves";
import type { PendingWords } from "../model/write";

/** What the user did here that the frame does not show yet. */
export function ActLines(props: {
  issue: string;
  words?: readonly PendingWords[] | undefined;
  onSayAgain?: ((key: string) => void) | undefined;
  onTakeBack?: ((key: string) => void) | undefined;
}) {
  const moves = useIntents(issueMove);
  const move = () => issueMoveOf(props.issue, moves.list());

  return (
    <If when={move() !== undefined || (props.words ?? []).length > 0}>
      <View class="mb-4 gap-2">
        <If when={move()}>
          {(m) => {
            const failed = () => m().state === "failed";
            return (
              <View
                testID="issue-move"
                accessibilityState={{ busy: m().state === "moving" }}
                class={`flex-row items-center gap-2 rounded-lg border px-3 py-2 ${failed() ? "bg-bad-soft" : "border-line bg-side"}`}
                style={failed() ? { borderColor: mix("berry", 0.25) } : undefined}
              >
                <Icon name={failed() ? "cross" : "wait"} size={14} tone={failed() ? "berry" : "muted"} />
                <Text class={`min-w-0 flex-1 truncate text-sm ${failed() ? "font-medium text-berry" : "text-muted"}`}>
                  {m().state === "moving" ? t("web.issue.acts.moving") : (m().reason ?? t("web.issue.board.moveFailed"))}
                </Text>
                <If when={failed()}>
                  <View class="shrink-0 flex-row items-center gap-0.5">
                    <IconButton testid="move-retry" icon="retry" size={14} label={t("web.issue.board.retryMove")} onClick={() => void moves.retry(m().key)} />
                    <IconButton testid="move-put-back" icon="undo" size={14} label={t("web.issue.board.putBack")} onClick={() => moves.drop(m().key)} />
                  </View>
                </If>
              </View>
            );
          }}
        </If>
        <Each of={props.words ?? []} key={(w) => w.key}>
          {(w) => {
            const failed = () => w().state === "failed";
            return (
              <View
                testID="issue-said"
                class={`flex-row items-start gap-2 rounded-lg border px-3 py-2 ${failed() ? "bg-bad-soft" : "border-line bg-side"}`}
                style={failed() ? { borderColor: mix("berry", 0.25) } : undefined}
              >
                <View class="mt-0.5 shrink-0">
                  <Icon name={failed() ? "cross" : "wait"} size={14} tone={failed() ? "berry" : "muted"} />
                </View>
                <View class="min-w-0 flex-1 gap-0.5">
                  <Text class="line-clamp-3 text-sm text-ink">{w().text}</Text>
                  <If when={failed()}>
                    <Text class="text-xs text-berry">{w().reason ?? t("web.issue.acts.notSaid")}</Text>
                  </If>
                </View>
                <If when={failed()} else={<Text class="mt-0.5 shrink-0 text-xs text-muted">{t("web.issue.acts.sending")}</Text>}>
                  <View class="shrink-0 flex-row items-center gap-0.5">
                    <IconButton testid="said-retry" icon="retry" size={14} label={t("web.issue.acts.sayAgain")} onClick={() => props.onSayAgain?.(w().key)} />
                    <IconButton
                      testid="said-take-back"
                      icon="undo"
                      size={14}
                      label={t("web.issue.acts.takeBack")}
                      onClick={() => props.onTakeBack?.(w().key)}
                    />
                  </View>
                </If>
              </View>
            );
          }}
        </Each>
      </View>
    </If>
  );
}
