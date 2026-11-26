import { computed, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { channelOf } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { Banner } from "../../../design/layout";
import { Markdown } from "../../../design/Markdown";
import { CountPill } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { api } from "../../../infra/api";
import { useNow } from "../../../infra/base/dom";
import { momentText, shortMomentText } from "../../../infra/base/format";
import { useCollabSlice } from "../../../infra/frame";
import { defineQuery, ready, retryRead, useQuery } from "../../../infra/query";
import { Composer, followed, issueThreadOf, useFollowed } from "../../channel";

const conversationQuery = defineQuery({
  key: (id: string) => ["issues", "conversation", id],
  fetch: (id, context) => api.issue.conversation.get({ id }, context),
  ...retryRead,
});

export function IssueThread(props: { issue: string }) {
  const collab = useCollabSlice();
  const now = useNow();
  const location = useQuery(() => conversationQuery(props.issue));
  const threadChannel = computed(() => issueThreadOf(collab()?.chat, props.issue) ?? channelOf(collab()?.chat, ready(location, undefined) ?? undefined));
  const thread = computed(() => threadChannel()?.id ?? ready(location, undefined) ?? undefined);
  const feed = useFollowed(thread);
  const act = createAct();
  const visible = computed(() => feed().messages.filter((message) => message.deleted === undefined));
  return (
    <View testID="issue-conversation" accessibilityLabel={t("web.issue.conversation.title")} class="mt-7 border-t border-line pt-5">
      <View class="mb-2.5 flex-row items-center gap-2">
        <Text class="text-xs font-semibold text-muted">{t("web.issue.conversation.title")}</Text>
        <If when={visible().length > 0}>
          <CountPill count={visible().length} />
        </If>
      </View>
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
          <View class="flex-row items-center gap-2 rounded-lg border border-line bg-side px-3.5 py-2.5">
            <Icon name="chat" size={14} tone="faint" />
            <Text class="min-w-0 flex-1 text-xs text-muted">{t("web.issue.conversation.empty")}</Text>
          </View>
        }
      >
        <View class="gap-2.5">
          <Each of={visible()} key={(message) => message.id}>
            {(message) => (
              <View testID="issue-message" class="min-w-0 rounded-lg border border-line bg-page px-3.5 py-3">
                <View class="mb-1.5 flex-row items-center justify-between gap-2">
                  <Text class="min-w-0 shrink truncate text-xs font-semibold text-ink">{message().name}</Text>
                  <View tooltip={<Bubble text={momentText(message().at)} />} class="shrink-0">
                    <Text class="text-2xs text-faint tabular-nums">{shortMomentText(message().at, now())}</Text>
                  </View>
                </View>
                <Markdown size="sm" text={message().text} />
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={threadChannel()}>
        {(ch) => (
          <View testID="issue-comment-composer" class="mt-3 rounded-lg border-r border-b border-l border-line bg-side">
            <Composer channel={ch()} placeholder={t("web.issue.conversation.placeholder")} />
          </View>
        )}
      </If>
    </View>
  );
}
