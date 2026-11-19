import { Scroll, Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { OrchestratorApproval } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { wallClockText } from "../../base/format";
import { api, reasonOf } from "../../infra/api";
import { defineQuery, retryRead, useQuery, useQueryClient } from "../../infra/query";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";

const approvalsQuery = defineQuery({
  schema: z.array(S.OrchestratorApproval),
  key: (conversationId: string) => ["orchestrator-approvals", conversationId],
  fetch: (conversationId, context) => api.orchestrator.approval.list({ conversationId }, context),
  ...retryRead,
});

export function PendingApprovals(props: { conversationId: string }) {
  const conversationId = props.conversationId;
  const client = useQueryClient();
  const descriptor = approvalsQuery(conversationId);
  const query = useQuery(() => descriptor, { interval: () => 3_000 });
  const pending = () => query.data()?.filter((approval) => approval.conversationId === conversationId) ?? [];
  const act = createAct();
  const decide = async (approval: OrchestratorApproval, approved: boolean) => {
    if (act.busy()) return;
    await act.run(async () => {
      const { conversationId, taskId, toolCallId } = approval;
      try {
        await api.orchestrator.approval.resolve({ conversationId, taskId, toolCallId, approved });
      } finally {
        await client.invalidate({ key: descriptor.key });
      }
    });
  };
  return (
    <If
      when={query.error()}
      else={
        <If when={pending().length > 0}>
          <View testID="orchestrator-approvals" class="gap-1">
            <Text role="header" class="text-sm font-semibold text-ink">
              {t("web.orchestrator.approval.title")}
            </Text>
            <Scroll class="max-h-48 shrink" contentClass="gap-2">
              <Each of={pending()}>
                {(item) => (
                  <View class="gap-1 rounded-md border border-line bg-page p-2">
                    <View class="flex-row flex-wrap items-center gap-2">
                      <Text class="text-sm font-semibold text-ink">{item().toolName}</Text>
                      <Text class="text-xs text-muted">{wallClockText(item().requestedAtMs)}</Text>
                    </View>
                    <Text class="text-sm text-ink">{item().reason}</Text>
                    <Text class="text-xs text-muted">{t("web.session.trajectory.input")}</Text>
                    <Text class="font-mono text-xs text-ink" style={{ userSelect: "text" }}>
                      {item().argumentsJson}
                    </Text>
                    <View class="flex-row items-center gap-2">
                      <Button testID={`approval-allow-${item().toolCallId}`} disabled={act.busy()} onPress={() => void decide(item(), true)}>
                        {t("web.orchestrator.approval.allow")}
                      </Button>
                      <Button testID={`approval-deny-${item().toolCallId}`} disabled={act.busy()} onPress={() => void decide(item(), false)}>
                        {t("web.orchestrator.approval.deny")}
                      </Button>
                    </View>
                  </View>
                )}
              </Each>
            </Scroll>
          </View>
        </If>
      }
    >
      <Text testID="orchestrator-approvals-error" class="text-sm text-berry">
        {t("web.orchestrator.approval.unavailable", { why: reasonOf(query.error()) })}
      </Text>
    </If>
  );
}
