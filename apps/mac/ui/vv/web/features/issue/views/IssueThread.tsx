import { Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { wallClockText } from "../../../base/format";
import { api } from "../../../infra/api";
import { useCore } from "../../../infra/frame";
import { defineQuery, ready, retryRead, useQuery } from "../../../infra/query";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Markdown } from "../../../ui/Markdown";
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
  const location = useQuery(() => conversationQuery(props.issue));
  const thread = () => issueThreadOf(core()?.chat, props.issue)?.id ?? ready(location, undefined) ?? undefined;
  const feed = useFollowed(thread);
  const act = createAct();
  return (
    <View testID="issue-conversation" accessibilityLabel={t("web.issue.conversation.title")}>
      <SheetLabel>{t("web.issue.conversation.title")}</SheetLabel>
      <If when={feed().error}>{(error) => <Text class="text-sm text-berry">{error()}</Text>}</If>
      <If when={thread() && feed().ready && !feed().complete}>
        <Button
          class="self-start"
          disabled={act.busy()}
          onPress={() => {
            const id = thread();
            if (id) void act.run(() => followed.loadOlder(id));
          }}
        >
          {t("web.issue.conversation.older")}
        </Button>
      </If>
      <If when={feed().messages.length > 0} else={<Text class="text-sm text-muted">{t("web.issue.conversation.empty")}</Text>}>
        <View class="gap-4">
          <Each of={feed().messages.filter((message) => message.deleted === undefined)}>
            {(message) => (
              <View testID="issue-message" class="min-w-0">
                <View class="mb-1 flex-row flex-wrap items-baseline gap-2">
                  <Text class="text-xs font-medium text-ink">{message().name}</Text>
                  <Text class="text-xs text-muted">{wallClockText(message().at)}</Text>
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
