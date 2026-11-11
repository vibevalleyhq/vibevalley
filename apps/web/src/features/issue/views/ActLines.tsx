import * as stylex from "@stylexjs/stylex";
import { For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { issueMove, issueMoveOf } from "#/features/issue/model/moves.ts";
import type { PendingWords } from "#/features/issue/model/write.ts";
import { useIntents } from "#/state/intent.ts";
import { Icon } from "#/ui/Icon.tsx";

const styles = stylex.create({
  actLinesButton: {
    display: "inline-flex",
    width: "1.5rem",
    height: "1.5rem",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  actLinesSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  actLinesSpanTone: {
    color: "var(--color-berry)",
  },
  actLinesSpanAlt: {
    color: "var(--color-muted)",
  },
  actLinesSpan2: {
    flexShrink: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  actLinesDiv: {
    marginBottom: "1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  issueMove: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  actLinesSpan3: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "pre-wrap",
    overflow: "hidden",
  },
});

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
      <div {...stylex.attrs(styles.actLinesDiv)}>
        <Show when={move()}>
          {(m) => (
            <div data-testid="issue-move" data-state={m().state} aria-busy={m().state === "moving" ? "true" : undefined} {...stylex.attrs(styles.issueMove)}>
              <span {...stylex.attrs(styles.actLinesSpan, m().state === "failed" ? styles.actLinesSpanTone : styles.actLinesSpanAlt)} title={m().reason}>
                {m().state === "moving" ? t("web.issue.acts.moving") : (m().reason ?? t("web.issue.board.moveFailed"))}
              </span>
              <Show when={m().state === "failed"}>
                <button
                  type="button"
                  data-testid="move-retry"
                  aria-label={t("web.issue.board.retryMove")}
                  title={t("web.issue.board.retryMove")}
                  onClick={() => void moves.retry(untrack(m).key)}
                  {...stylex.attrs(styles.actLinesButton)}
                >
                  <Icon name="retry" size={14} />
                </button>
                <button
                  type="button"
                  data-testid="move-put-back"
                  aria-label={t("web.issue.board.putBack")}
                  title={t("web.issue.board.putBack")}
                  onClick={() => moves.drop(untrack(m).key)}
                  {...stylex.attrs(styles.actLinesButton)}
                >
                  <Icon name="close" size={14} />
                </button>
              </Show>
            </div>
          )}
        </Show>
        <For each={props.words ?? []} keyed={(w) => w.key}>
          {(w) => (
            <div data-testid="issue-said" data-key={w().key} data-state={w().state} {...stylex.attrs(styles.issueMove)}>
              <span {...stylex.attrs(styles.actLinesSpan3)}>{w().text}</span>
              <span {...stylex.attrs(styles.actLinesSpan2, w().state === "failed" ? styles.actLinesSpanTone : styles.actLinesSpanAlt)} title={w().reason}>
                {w().state === "sending" ? t("web.issue.acts.sending") : (w().reason ?? t("web.issue.acts.notSaid"))}
              </span>
              <Show when={w().state === "failed"}>
                <button
                  type="button"
                  data-testid="said-retry"
                  aria-label={t("web.issue.acts.sayAgain")}
                  title={t("web.issue.acts.sayAgain")}
                  onClick={() => props.onSayAgain?.(untrack(w).key)}
                  {...stylex.attrs(styles.actLinesButton)}
                >
                  <Icon name="retry" size={14} />
                </button>
                <button
                  type="button"
                  data-testid="said-take-back"
                  aria-label={t("web.issue.acts.takeBack")}
                  title={t("web.issue.acts.takeBack")}
                  onClick={() => props.onTakeBack?.(untrack(w).key)}
                  {...stylex.attrs(styles.actLinesButton)}
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
