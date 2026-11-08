import * as stylex from "@stylexjs/stylex";
import { For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { useIntents } from "#/state/intent.ts";
import { Icon } from "#/ui/Icon.tsx";

import { issueMove, issueMoveOf } from "./moves";
import type { PendingWords } from "./write";

const viewStyles = stylex.create({
  actLinesDiv: {
    marginBottom: "calc(var(--spacing) * 4)",
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  issueMove: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  actLinesSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "pre-wrap",
    overflow: "hidden",
  },
});

/** What the owner did here that the frame does not show yet. */
export function ActLines(props: {
  issue: string;
  words?: readonly PendingWords[] | undefined;
  onSayAgain?: ((key: string) => void) | undefined;
  onTakeBack?: ((key: string) => void) | undefined;
}) {
  const moves = useIntents(issueMove);
  const move = () => issueMoveOf(props.issue, moves.list());
  const small = "inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink";
  return (
    <Show when={move() !== undefined || (props.words ?? []).length > 0}>
      <div {...stylex.attrs(viewStyles.actLinesDiv)}>
        <Show when={move()}>
          {(m) => (
            <div
              data-testid="issue-move"
              data-state={m().state}
              aria-busy={m().state === "moving" ? "true" : undefined}
              {...stylex.attrs(viewStyles.issueMove)}
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
                  class={small}
                >
                  <Icon name="retry" size={14} />
                </button>
                <button
                  type="button"
                  data-testid="move-put-back"
                  aria-label={t("web.issue.board.putBack")}
                  title={t("web.issue.board.putBack")}
                  onClick={() => moves.drop(untrack(m).key)}
                  class={small}
                >
                  <Icon name="close" size={14} />
                </button>
              </Show>
            </div>
          )}
        </Show>
        <For each={props.words ?? []} keyed={(w) => w.key}>
          {(w) => (
            <div data-testid="issue-said" data-key={w().key} data-state={w().state} {...stylex.attrs(viewStyles.issueMove)}>
              <span {...stylex.attrs(viewStyles.actLinesSpan)}>{w().text}</span>
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
                  class={small}
                >
                  <Icon name="retry" size={14} />
                </button>
                <button
                  type="button"
                  data-testid="said-take-back"
                  aria-label={t("web.issue.acts.takeBack")}
                  title={t("web.issue.acts.takeBack")}
                  onClick={() => props.onTakeBack?.(untrack(w).key)}
                  class={small}
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
