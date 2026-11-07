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
      <Show when={feed().error}>{(error) => <p class="text-sm text-berry">{error()}</p>}</Show>
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
      <Show when={feed().messages.length > 0} fallback={<p class="text-sm text-muted">{t("web.issue.conversation.empty")}</p>}>
        <div class="flex flex-col gap-4">
          <For each={feed().messages.filter((message) => message.deleted === undefined)}>
            {(message) => (
              <article data-testid="issue-message" class="min-w-0">
                <div class="mb-1 flex flex-wrap items-baseline gap-2 text-xs text-muted">
                  <span class="font-medium text-ink">{message.name}</span>
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
