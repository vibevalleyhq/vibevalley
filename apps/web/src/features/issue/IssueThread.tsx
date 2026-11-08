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

const viewStyles = stylex.create({
  issueThreadP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-berry)",
  },
  issueThreadP2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  issueThreadDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
  },
  issueMessage: {
    minWidth: "0",
  },
  issueThreadDiv2: {
    marginBottom: "var(--spacing)",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  issueThreadSpan: {
    fontWeight: "var(--font-weight-medium)",
    color: "var(--wb-ink)",
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
      <Show when={feed().error}>{(error) => <p {...stylex.attrs(viewStyles.issueThreadP)}>{error()}</p>}</Show>
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
      <Show when={feed().messages.length > 0} fallback={<p {...stylex.attrs(viewStyles.issueThreadP2)}>{t("web.issue.conversation.empty")}</p>}>
        <div {...stylex.attrs(viewStyles.issueThreadDiv)}>
          <For each={feed().messages.filter((message) => message.deleted === undefined)}>
            {(message) => (
              <article data-testid="issue-message" {...stylex.attrs(viewStyles.issueMessage)}>
                <div {...stylex.attrs(viewStyles.issueThreadDiv2)}>
                  <span {...stylex.attrs(viewStyles.issueThreadSpan)}>{message.name}</span>
                  <time>{wallClockText(message.at)}</time>
                </div>
                <Markdown class="text-sm break-words" text={message.text} />
              </article>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
