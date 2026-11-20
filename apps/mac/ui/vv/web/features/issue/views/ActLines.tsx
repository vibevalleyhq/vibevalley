import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { useIntents } from "../../../state/intent";
import { IconButton } from "../../../ui/IconButton";
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
      <View class="mb-4 gap-1.5">
        <If when={move()}>
          {(m) => (
            <View testID="issue-move" accessibilityState={{ busy: m().state === "moving" }} class="flex-row items-center gap-1.5">
              <Text class={`min-w-0 flex-1 truncate text-sm ${m().state === "failed" ? "text-berry" : "text-muted"}`}>
                {m().state === "moving" ? t("web.issue.acts.moving") : (m().reason ?? t("web.issue.board.moveFailed"))}
              </Text>
              <If when={m().state === "failed"}>
                <IconButton testid="move-retry" icon="retry" size={14} label={t("web.issue.board.retryMove")} onClick={() => void moves.retry(m().key)} />
                <IconButton testid="move-put-back" icon="close" size={14} label={t("web.issue.board.putBack")} onClick={() => moves.drop(m().key)} />
              </If>
            </View>
          )}
        </If>
        <Each of={props.words ?? []} key={(w) => w.key}>
          {(w) => (
            <View testID="issue-said" class="flex-row items-center gap-1.5">
              <Text class="line-clamp-3 min-w-0 flex-1 text-sm text-ink">{w().text}</Text>
              <Text class={`shrink-0 text-xs ${w().state === "failed" ? "text-berry" : "text-muted"}`}>
                {w().state === "sending" ? t("web.issue.acts.sending") : (w().reason ?? t("web.issue.acts.notSaid"))}
              </Text>
              <If when={w().state === "failed"}>
                <IconButton testid="said-retry" icon="retry" size={14} label={t("web.issue.acts.sayAgain")} onClick={() => props.onSayAgain?.(w().key)} />
                <IconButton testid="said-take-back" icon="close" size={14} label={t("web.issue.acts.takeBack")} onClick={() => props.onTakeBack?.(w().key)} />
              </If>
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
