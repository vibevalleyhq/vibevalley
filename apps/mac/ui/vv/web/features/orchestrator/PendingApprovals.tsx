import { Scroll, signal, Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { OrchestratorApproval } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { momentText, wallClockText } from "../../base/format";
import { api, reasonOf } from "../../infra/api";
import { defineQuery, retryRead, useQuery, useQueryClient } from "../../infra/query";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Banner } from "../../ui/layout";
import { Bubble } from "../../ui/Tip";
import { mix } from "../../ui/tone";

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
          <View testID="orchestrator-approvals" class="shrink-0 overflow-hidden rounded-lg border bg-page" style={{ borderColor: mix("wheat", 0.5) }}>
            <View class="flex-row items-center justify-between gap-2 border-b border-line px-3.5 py-2" style={{ backgroundColor: mix("wheat", 0.12) }}>
              <View class="min-w-0 flex-1 flex-row items-center gap-2">
                <Icon name="warn" size={14} />
                <Text role="header" class="truncate text-sm font-semibold text-ink">
                  {t("web.orchestrator.approval.title")}
                </Text>
              </View>
              <View class="h-5 flex-row items-center rounded-full px-2" style={{ backgroundColor: mix("wheat", 0.22) }}>
                <Text class="font-mono text-2xs font-medium text-warn-ink tabular-nums">{String(pending().length)}</Text>
              </View>
            </View>
            <Scroll class="max-h-72 shrink">
              <Each of={pending()} key={(item) => item.toolCallId}>
                {(item, index) => <ApprovalRow item={item()} first={index() === 0} busy={act.busy()} onDecide={(ok) => void decide(item(), ok)} />}
              </Each>
            </Scroll>
          </View>
        </If>
      }
    >
      <Banner testID="orchestrator-approvals-error">{t("web.orchestrator.approval.unavailable", { why: reasonOf(query.error()) })}</Banner>
    </If>
  );
}

function ApprovalRow(props: { item: OrchestratorApproval; first: boolean; busy: boolean; onDecide: (approved: boolean) => void }) {
  const expanded = signal(true);
  return (
    <View class={`gap-2 px-3.5 py-3 ${props.first ? "" : "border-t border-line"}`}>
      <View class="flex-row items-center justify-between gap-2">
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <View class="size-2 shrink-0 rounded-full bg-wheat" />
          <View class="rounded-sm bg-side px-2 py-0.5">
            <Text class="truncate font-mono text-xs font-semibold text-ink">{props.item.toolName}</Text>
          </View>
        </View>
        <View tooltip={<Bubble text={momentText(props.item.requestedAtMs)} />} class="shrink-0">
          <Text class="font-mono text-xs text-muted tabular-nums">{wallClockText(props.item.requestedAtMs)}</Text>
        </View>
      </View>
      <Text class="text-sm leading-relaxed text-ink">{props.item.reason}</Text>
      <View class="gap-1">
        <View
          role="button"
          accessibilityState={{ expanded: expanded() }}
          onPress={() => expanded.set(!expanded())}
          class="group -ml-1 h-6 flex-row items-center gap-1 self-start rounded-sm px-1 transition duration-120 ease-out hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        >
          <View
            class="size-3.5 shrink-0 items-center justify-center transition-transform duration-120 ease-out"
            style={{ transform: [{ rotate: expanded() ? "90deg" : "0deg" }] }}
          >
            <Icon name="expand" size={10} tone="faint" />
          </View>
          <Text class="text-xs font-medium text-muted group-hover:text-ink">{t("web.session.trajectory.input")}</Text>
        </View>
        <If when={expanded()}>
          <View class="rounded-md bg-side px-2.5 py-2">
            <Text class="font-mono text-xs leading-relaxed text-ink" style={{ userSelect: "text" }}>
              {props.item.argumentsJson}
            </Text>
          </View>
        </If>
      </View>
      <View class="flex-row items-center gap-2 pt-0.5">
        <Button tone="primary" icon="ticked" testID={`approval-allow-${props.item.toolCallId}`} disabled={props.busy} onPress={() => props.onDecide(true)}>
          {t("web.orchestrator.approval.allow")}
        </Button>
        <Button tone="danger" icon="close" testID={`approval-deny-${props.item.toolCallId}`} disabled={props.busy} onPress={() => props.onDecide(false)}>
          {t("web.orchestrator.approval.deny")}
        </Button>
      </View>
    </View>
  );
}
