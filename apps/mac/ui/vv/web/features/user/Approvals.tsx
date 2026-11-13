// Ported from VibeValley apps/web/src/features/user/Approvals.tsx: the
// sign-in requests waiting on this page's say, and /approve.
import { Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Approval } from "@vibevalley/protocol";

import { useNow } from "../../base/dom";
import { momentText } from "../../base/format";
import { api } from "../../infra/api";
import { ready, useQuery, useQueryClient } from "../../infra/query";
import { useSearch } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { SettingsPage as Page } from "../../ui/domain/settings";
import { Card, Quiet } from "../../ui/layout";
import { approvalsQuery } from "./signIns";

/** The sign-in requests waiting on this page's say, the one matching `code` first; approving signs that device in. */
export function Approvals(props: { code?: string | undefined; always?: boolean }) {
  const client = useQueryClient();
  // Polled: a device asking right now shows up without a reload.
  const approvals = useQuery(approvalsQuery, { interval: () => 2000 });
  const act = createAct();
  const now = useNow(1000);
  const list = () => {
    const all = ready(approvals, undefined) ?? [];
    // The one the link names first; the rest, if any, after it.
    const named = props.code;
    return [...all.filter((a) => a.code === named), ...all.filter((a) => a.code !== named)];
  };
  const answer = (a: Approval, allow: boolean) =>
    void act.run(() => api.user.approval.answer({ id: a.id, allow }).then((left) => client.setData(approvalsQuery(), () => ({ value: left }))));
  return (
    <If when={list().length > 0 || props.always === true}>
      <Card title={t("web.user.approvals.title")} testid="approvals">
        <If when={list().length > 0} else={<Quiet>{t("web.user.approvals.none")}</Quiet>}>
          <Text class="text-sm text-berry">{t("web.user.approvals.onlyYours")}</Text>
          <Each of={list()} key={(a) => a.id}>
            {(a) => (
              <View testID={`approval-${a().code}`} class="flex-row flex-wrap items-center gap-2">
                <View class="min-w-0 flex-1">
                  <Text class="text-sm font-medium text-ink">{t("web.user.approvals.wants", { name: a().name })}</Text>
                  <Text class="font-mono text-lg text-ink" style={{ letterSpacing: 1.4 }}>
                    {a().code}
                  </Text>
                  <Text testID="approval-from" class="text-xs text-muted">
                    {a().from === ""
                      ? t("web.user.approvals.fromHere", { at: momentText(a().askedAt) })
                      : t("web.user.approvals.from", { from: a().from, at: momentText(a().askedAt) })}
                  </Text>
                  <Text class="text-xs text-muted">{t("web.user.approvals.left", { m: Math.max(0, Math.ceil((a().expiresAt - now()) / 60_000)) })}</Text>
                </View>
                <Button tone="primary" testID="approval-allow" disabled={act.busy()} onPress={() => answer(a(), true)}>
                  {t("web.user.approvals.allow")}
                </Button>
                <Button tone="danger" testID="approval-refuse" disabled={act.busy()} onPress={() => answer(a(), false)}>
                  {t("web.user.approvals.refuse")}
                </Button>
              </View>
            )}
          </Each>
        </If>
      </Card>
    </If>
  );
}

/** /approve?code=…: where `vibevalley auth login` sends the user to let that terminal in. */
export function ApprovePage() {
  const params = useSearch();
  return (
    <Scroll testID="approve-page" class="h-full" contentClass="p-5">
      <Page title={t("web.user.approvals.page")} hint={t("web.user.approvals.hint")}>
        <View class="max-w-3xl gap-3">
          <Approvals code={params().get("code") ?? undefined} always />
        </View>
      </Page>
    </Scroll>
  );
}
