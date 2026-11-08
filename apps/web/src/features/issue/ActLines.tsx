import * as stylex from "@stylexjs/stylex";
import { For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { useIntents } from "#/state/intent.ts";
import { Icon } from "#/ui/Icon.tsx";

import { issueMove, issueMoveOf } from "./moves";
import type { PendingWords } from "./write";

const recipeStyles = stylex.create({
  actLinesButton: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 6)",
    height: "calc(var(--spacing) * 6)",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
});

const variantStyles = stylex.create({
  actLinesSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  actLinesSpanVariant: {
    color: "var(--wb-berry)",
  },
  actLinesSpanVariant2: {
    color: "var(--wb-muted)",
  },
  actLinesSpan2: {
    flexShrink: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
});

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
              <span
                {...stylex.attrs(variantStyles.actLinesSpan, m().state === "failed" ? variantStyles.actLinesSpanVariant : variantStyles.actLinesSpanVariant2)}
                title={m().reason}
              >
                {m().state === "moving" ? t("web.issue.acts.moving") : (m().reason ?? t("web.issue.board.moveFailed"))}
              </span>
              <Show when={m().state === "failed"}>
                <button
                  type="button"
                  data-testid="move-retry"
                  aria-label={t("web.issue.board.retryMove")}
                  title={t("web.issue.board.retryMove")}
                  onClick={() => void moves.retry(untrack(m).key)}
                  {...stylex.attrs(recipeStyles.actLinesButton)}
                >
                  <Icon name="retry" size={14} />
                </button>
                <button
                  type="button"
                  data-testid="move-put-back"
                  aria-label={t("web.issue.board.putBack")}
                  title={t("web.issue.board.putBack")}
                  onClick={() => moves.drop(untrack(m).key)}
                  {...stylex.attrs(recipeStyles.actLinesButton)}
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
              <span
                {...stylex.attrs(variantStyles.actLinesSpan2, w().state === "failed" ? variantStyles.actLinesSpanVariant : variantStyles.actLinesSpanVariant2)}
                title={w().reason}
              >
                {w().state === "sending" ? t("web.issue.acts.sending") : (w().reason ?? t("web.issue.acts.notSaid"))}
              </span>
              <Show when={w().state === "failed"}>
                <button
                  type="button"
                  data-testid="said-retry"
                  aria-label={t("web.issue.acts.sayAgain")}
                  title={t("web.issue.acts.sayAgain")}
                  onClick={() => props.onSayAgain?.(untrack(w).key)}
                  {...stylex.attrs(recipeStyles.actLinesButton)}
                >
                  <Icon name="retry" size={14} />
                </button>
                <button
                  type="button"
                  data-testid="said-take-back"
                  aria-label={t("web.issue.acts.takeBack")}
                  title={t("web.issue.acts.takeBack")}
                  onClick={() => props.onTakeBack?.(untrack(w).key)}
                  {...stylex.attrs(recipeStyles.actLinesButton)}
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
