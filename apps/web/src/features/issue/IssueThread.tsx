import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { wallClockText } from "#/base/format.ts";
import { followed, issueThreadOf, useFollowed } from "#/features/channel/index.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { defineQuery, retryRead, useQuery, ready } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Markdown } from "#/ui/Markdown.tsx";

import { SheetLabel } from "./Sheet";

const styles = stylex.create({
  issueThreadMarkdown: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    overflowWrap: "break-word",
  },
  issueThreadP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-berry)",
  },
  issueThreadP2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  issueThreadDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  issueMessage: {
    minWidth: "0",
  },
  issueThreadDiv2: {
    marginBottom: "0.25rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  issueThreadSpan: {
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-ink)",
  },
});

const conversationQuery = defineQuery({
  schema: Schema.NullOr(Schema.String),
  key: (id: string) => ["issues", "conversation", id],
  fetch: (id, context) => api.issue.conversation.get({ id }, context),
  ...retryRead,
});

export function IssueThread(props: { issue: string }) {
  const core = useCore();
  const location = useQuery(() => conversationQuery(props.issue));
  const thread = () => issueThreadOf(core()?.chat, props.issue)?.id ?? ready(location, undefined) ?? undefined;
  const feed = useFollowed(thread);
  const act = createAct();
  return (
    <section data-testid="issue-conversation" aria-label={t("web.issue.conversation.title")}>
      <SheetLabel>{t("web.issue.conversation.title")}</SheetLabel>
      <Show when={feed().error}>{(error) => <p {...stylex.attrs(styles.issueThreadP)}>{error()}</p>}</Show>
      <Show when={thread() && feed().ready && !feed().complete}>
        <Button
          disabled={act.busy()}
          onClick={() => {
            const id = thread();
            if (id) void act.run(() => followed.loadOlder(id));
          }}
        >
          {t("web.issue.conversation.older")}
        </Button>
      </Show>
      <Show when={feed().messages.length > 0} fallback={<p {...stylex.attrs(styles.issueThreadP2)}>{t("web.issue.conversation.empty")}</p>}>
        <div {...stylex.attrs(styles.issueThreadDiv)}>
          <For each={feed().messages.filter((message) => message.deleted === undefined)}>
            {(message) => (
              <article data-testid="issue-message" {...stylex.attrs(styles.issueMessage)}>
                <div {...stylex.attrs(styles.issueThreadDiv2)}>
                  <span {...stylex.attrs(styles.issueThreadSpan)}>{message.name}</span>
                  <time>{wallClockText(message.at)}</time>
                </div>
                <Markdown styles={styles.issueThreadMarkdown} text={message.text} />
              </article>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
