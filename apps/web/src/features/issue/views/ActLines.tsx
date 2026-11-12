import { For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { issueMove, issueMoveOf } from "#/features/issue/model/moves.ts";
import type { PendingWords } from "#/features/issue/model/write.ts";
import { useIntents } from "#/state/intent.ts";
import { Icon } from "#/ui/Icon.tsx";

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
    <Show when={move() !== undefined || (props.words ?? []).length > 0}>
      <div class="mb-4 flex flex-col gap-1.5">
        <Show when={move()}>
          {(m) => (
            <div
              data-testid="issue-move"
              data-state={m().state}
              aria-busy={m().state === "moving" ? "true" : undefined}
              class="flex items-center gap-1.5 text-sm"
            >
              <span class={["min-w-0 flex-1 truncate", m().state === "failed" ? "text-berry" : "text-muted"]} title={m().reason}>
                {m().state === "moving" ? t("web.issue.acts.moving") : (m().reason ?? t("web.issue.board.moveFailed"))}
              </span>
              <Show when={m().state === "failed"}>
                <button
                  type="button"
                  data-testid="move-retry"
                  aria-label={t("web.issue.board.retryMove")}
                  title={t("web.issue.board.retryMove")}
                  onClick={() => void moves.retry(untrack(m).key)}
                  class="inline-flex w-6 h-6 cursor-pointer items-center justify-center rounded-md text-muted hover:text-ink hover:bg-hover"
                >
                  <Icon name="retry" size={14} />
                </button>
                <button
                  type="button"
                  data-testid="move-put-back"
                  aria-label={t("web.issue.board.putBack")}
                  title={t("web.issue.board.putBack")}
                  onClick={() => moves.drop(untrack(m).key)}
                  class="inline-flex w-6 h-6 cursor-pointer items-center justify-center rounded-md text-muted hover:text-ink hover:bg-hover"
                >
                  <Icon name="close" size={14} />
                </button>
              </Show>
            </div>
          )}
        </Show>
        <For each={props.words ?? []} keyed={(w) => w.key}>
          {(w) => (
            <div data-testid="issue-said" data-key={w().key} data-state={w().state} class="flex items-center gap-1.5 text-sm">
              <span class="min-w-0 flex-1 text-ellipsis whitespace-pre-wrap overflow-hidden">{w().text}</span>
              <span class={["shrink-0 text-xs", w().state === "failed" ? "text-berry" : "text-muted"]} title={w().reason}>
                {w().state === "sending" ? t("web.issue.acts.sending") : (w().reason ?? t("web.issue.acts.notSaid"))}
              </span>
              <Show when={w().state === "failed"}>
                <button
                  type="button"
                  data-testid="said-retry"
                  aria-label={t("web.issue.acts.sayAgain")}
                  title={t("web.issue.acts.sayAgain")}
                  onClick={() => props.onSayAgain?.(untrack(w).key)}
                  class="inline-flex w-6 h-6 cursor-pointer items-center justify-center rounded-md text-muted hover:text-ink hover:bg-hover"
                >
                  <Icon name="retry" size={14} />
                </button>
                <button
                  type="button"
                  data-testid="said-take-back"
                  aria-label={t("web.issue.acts.takeBack")}
                  title={t("web.issue.acts.takeBack")}
                  onClick={() => props.onTakeBack?.(untrack(w).key)}
                  class="inline-flex w-6 h-6 cursor-pointer items-center justify-center rounded-md text-muted hover:text-ink hover:bg-hover"
                >
                  <Icon name="close" size={14} />
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
