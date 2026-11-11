import * as stylex from "@stylexjs/stylex";
import { Array as Arr } from "effect";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Approval } from "@vibevalley/protocol";

import { useNow } from "#/base/dom.tsx";
import { momentText } from "#/base/format.ts";
import { api } from "#/infra/api.ts";
import { ready, useQuery, useQueryClient } from "#/infra/query.ts";
import { useSearch } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";
import { SettingsPage as Page } from "#/ui/settings.tsx";

import { approvalsQuery } from "./signIns";

const viewStyles = stylex.create({
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  text: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  name: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
  },
  code: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--leading-lg)",
    letterSpacing: "0.08em",
  },
  when: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  warn: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-berry)",
  },
  page: {
    height: "100%",
    overflowY: "auto",
    padding: "1.25rem",
  },
  body: {
    display: "flex",
    maxWidth: "var(--container-3xl)",
    flexDirection: "column",
    gap: "0.75rem",
  },
});

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
    return [...Arr.filter(all, (a) => a.code === named), ...Arr.filter(all, (a) => a.code !== named)];
  };
  const answer = (a: Approval, allow: boolean) =>
    void act.run(() => api.user.approval.answer({ id: a.id, allow }).then((left) => client.setData(approvalsQuery(), () => ({ value: left }))));
  return (
    <Show when={list().length > 0 || props.always === true}>
      <Card title={t("web.user.approvals.title")} testid="approvals">
        <Show when={list().length > 0} fallback={<Quiet>{t("web.user.approvals.none")}</Quiet>}>
          <p {...stylex.attrs(viewStyles.warn)}>{t("web.user.approvals.onlyYours")}</p>
          <For each={list()}>
            {(a) => (
              <div data-key={a.id} data-code={a.code} {...stylex.attrs(viewStyles.row)}>
                <span {...stylex.attrs(viewStyles.text)}>
                  <span {...stylex.attrs(viewStyles.name)}>{t("web.user.approvals.wants", { name: a.name })}</span>
                  <span {...stylex.attrs(viewStyles.code)}>{a.code}</span>
                  <span data-testid="approval-from" {...stylex.attrs(viewStyles.when)}>
                    {a.from === ""
                      ? t("web.user.approvals.fromHere", { at: momentText(a.askedAt) })
                      : t("web.user.approvals.from", { from: a.from, at: momentText(a.askedAt) })}
                  </span>
                  <span {...stylex.attrs(viewStyles.when)}>{t("web.user.approvals.left", { m: Math.max(0, Math.ceil((a.expiresAt - now()) / 60_000)) })}</span>
                </span>
                <Button tone="primary" data-testid="approval-allow" disabled={act.busy()} onClick={() => answer(a, true)}>
                  {t("web.user.approvals.allow")}
                </Button>
                <Button tone="danger" data-testid="approval-refuse" disabled={act.busy()} onClick={() => answer(a, false)}>
                  {t("web.user.approvals.refuse")}
                </Button>
              </div>
            )}
          </For>
        </Show>
      </Card>
    </Show>
  );
}

/** /approve?code=…: where `vibevalley auth login` sends the user to let that terminal in. */
export function ApprovePage() {
  const params = useSearch();
  return (
    <div {...stylex.attrs(viewStyles.page)}>
      <Page title={t("web.user.approvals.page")} hint={t("web.user.approvals.hint")}>
        <div {...stylex.attrs(viewStyles.body)}>
          <Approvals code={params().get("code") ?? undefined} always />
        </div>
      </Page>
    </div>
  );
}
