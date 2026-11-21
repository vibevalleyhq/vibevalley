// Ported from VibeValley apps/web/src/features/issue/views/IssueThread.tsx:
// the issue's conversation, read through the chat's own model
// (features/channel, vendored by the chat port).
import { Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { useNow } from "../../../base/dom";
import { momentText, shortMomentText } from "../../../base/format";
import { api } from "../../../infra/api";
import { useCore } from "../../../infra/frame";
import { defineQuery, ready, retryRead, useQuery } from "../../../infra/query";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";
import { Banner } from "../../../ui/layout";
import { Markdown } from "../../../ui/Markdown";
import { Bubble } from "../../../ui/Tip";
import { mix } from "../../../ui/tone";
import { followed, useFollowed } from "../../channel/model/follow";
import { issueThreadOf } from "../../channel/model/places";
import { SheetLabel } from "./Sheet";

const conversationQuery = defineQuery({
  schema: z.string().nullable(),
  key: (id: string) => ["issues", "conversation", id],
  fetch: (id, context) => api.issue.conversation.get({ id }, context),
  ...retryRead,
});

export function IssueThread(props: { issue: string }) {
  const core = useCore();
  const now = useNow();
  const location = useQuery(() => conversationQuery(props.issue));
  const thread = () => issueThreadOf(core()?.chat, props.issue)?.id ?? ready(location, undefined) ?? undefined;
  const feed = useFollowed(thread);
  const act = createAct();
  const visible = () => feed().messages.filter((message) => message.deleted === undefined);
  return (
    <View testID="issue-conversation" accessibilityLabel={t("web.issue.conversation.title")}>
      <SheetLabel>{t("web.issue.conversation.title")}</SheetLabel>
      <If when={feed().error}>{(error) => <Banner class="mb-3">{error()}</Banner>}</If>
      <If when={thread() && feed().ready && !feed().complete}>
        <Button
          tone="quiet"
          icon="clock"
          class="mb-3 self-start"
          disabled={act.busy()}
          onPress={() => {
            const id = thread();
            if (id) void act.run(() => followed.loadOlder(id));
          }}
        >
          {t("web.issue.conversation.older")}
        </Button>
      </If>
      <If
        when={visible().length > 0}
        else={
          <View class="flex-row items-center gap-2 rounded-md bg-side px-3 py-2.5">
            <Icon name="chat" size={14} tone="faint" />
            <Text class="min-w-0 flex-1 text-xs text-muted">{t("web.issue.conversation.empty")}</Text>
          </View>
        }
      >
        <View>
          <Each of={visible()} key={(message) => message.id}>
            {(message, i) => (
              <View
                testID="issue-message"
                class={`min-w-0 ${i() > 0 ? "mt-3 border-t pt-3" : ""}`}
                style={i() > 0 ? { borderColor: mix("line", 0.7) } : undefined}
              >
                <View class="mb-1 flex-row items-baseline gap-2">
                  <Text class="min-w-0 shrink truncate text-xs font-semibold text-ink">{message().name}</Text>
                  <View tooltip={<Bubble text={momentText(message().at)} />} class="shrink-0">
                    <Text class="text-xs text-faint tabular-nums">{shortMomentText(message().at, now())}</Text>
                  </View>
                </View>
                <Markdown size="sm" text={message().text} />
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
