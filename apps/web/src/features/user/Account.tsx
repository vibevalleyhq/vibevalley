import * as stylex from "@stylexjs/stylex";
import { createSignal, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { UserStatus } from "@vibevalley/protocol";

import { api, reasonOf } from "#/infra/api.ts";
import { ready, useQuery, useQueryClient } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Field, TextInput } from "#/ui/Field.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";
import { toast } from "#/ui/toasts.ts";

import { userQuery } from "./signIns";

const viewStyles = stylex.create({
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: "calc(var(--spacing) * 2)",
  },
  grow: { minWidth: "calc(var(--spacing) * 48)", flex: "1" },
  note: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
  },
});

/** The user's name, the password (set only at this computer), and signing this device out. */
export function Account() {
  const client = useQueryClient();
  const status = useQuery(userQuery);
  const act = createAct();
  const keep = (s: UserStatus) => client.setData(userQuery(), () => ({ value: s }));
  const s = () => ready(status, undefined);
  const [name, setName] = createSignal<string | undefined>(undefined);
  const [password, setPassword] = createSignal("");
  const shownName = () => name() ?? s()?.name ?? "";

  return (
    <Card title={t("web.user.account.title")} testid="account">
      <Show when={s()} fallback={<Quiet>{status.error() ? reasonOf(status.error()) : t("web.base.form.asking")}</Quiet>}>
        {(s) => (
          <div {...stylex.attrs(viewStyles.body)}>
            <form
              {...stylex.attrs(viewStyles.row)}
              onSubmit={(e) => {
                e.preventDefault();
                const next = shownName();
                void act.run(() =>
                  api.user.update({ name: next }).then((saved) => {
                    keep(saved);
                    setName(undefined);
                    toast(t("web.user.account.nameSaved"));
                  }),
                );
              }}
            >
              <div {...stylex.attrs(viewStyles.grow)}>
                <Field label={t("web.user.account.name")} hint={t("web.user.account.nameHint")}>
                  <TextInput data-testid="account-name" value={shownName()} onInput={(e) => setName(e.currentTarget.value)} maxlength={40} />
                </Field>
              </div>
              <Button type="submit" data-testid="account-name-save" disabled={act.busy() || name() === undefined}>
                {t("web.user.account.save")}
              </Button>
            </form>
            <Show when={s().here} fallback={<p {...stylex.attrs(viewStyles.note)}>{t("web.user.account.passwordHere")}</p>}>
              <form
                {...stylex.attrs(viewStyles.row)}
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = password();
                  void act.run(() =>
                    api.user.password.set({ password: next }).then((saved) => {
                      keep(saved);
                      setPassword("");
                      toast(t("web.user.account.passwordSaved"));
                    }),
                  );
                }}
              >
                <div {...stylex.attrs(viewStyles.grow)}>
                  <Field label={t("web.user.account.password")} hint={t("web.user.account.passwordHint")}>
                    <TextInput
                      data-testid="account-password"
                      type="password"
                      autocomplete="new-password"
                      value={password()}
                      onInput={(e) => setPassword(e.currentTarget.value)}
                    />
                  </Field>
                </div>
                <Button type="submit" data-testid="account-password-save" disabled={act.busy() || password() === ""}>
                  {s().password ? t("web.user.account.changePassword") : t("web.user.account.setPassword")}
                </Button>
              </form>
            </Show>
            <Show when={s().device}>
              {(device) => (
                <div {...stylex.attrs(viewStyles.row)}>
                  <p {...stylex.attrs(viewStyles.note, viewStyles.grow)}>{t("web.user.account.thisDevice", { name: device().name })}</p>
                  <Button
                    data-testid="account-sign-out"
                    disabled={act.busy()}
                    onClick={() =>
                      void act.run(() => {
                        const back = device().came === "login" ? "/login" : "/pair";
                        return api.user.logout().then(() => location.replace(back));
                      })
                    }
                  >
                    {t("web.user.account.signOut")}
                  </Button>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </Card>
  );
}
