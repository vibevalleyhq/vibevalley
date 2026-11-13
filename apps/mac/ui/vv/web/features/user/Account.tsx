// Ported from VibeValley apps/web/src/features/user/Account.tsx. The forms
// submit from their buttons and the inputs' Return; signing out goes to
// the sign-in or pairing page through the router (VibeValley has no page reload).
// No `maxlength` on nsh's Input: the server refuses a name over 40.
import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { UserStatus } from "@vibevalley/protocol";

import { api, reasonOf } from "../../infra/api";
import { ready, useQuery, useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Field, TextInput } from "../../ui/Field";
import { Card, Quiet } from "../../ui/layout";
import { toast } from "../../ui/toasts";
import { userQuery } from "./signIns";

/** The user's name, the password (set only at this computer), and signing this device out. */
export function Account() {
  const client = useQueryClient();
  const router = useRouter();
  const status = useQuery(userQuery);
  const act = createAct();
  const keep = (s: UserStatus) => client.setData(userQuery(), () => ({ value: s }));
  const s = () => ready(status, undefined);
  const name = signal<string | undefined>(undefined);
  const password = signal("");
  const shownName = () => name() ?? s()?.name ?? "";
  const saveName = () => {
    if (act.busy() || name() === undefined) return;
    const next = shownName();
    void act.run(() =>
      api.user.update({ name: next }).then((saved) => {
        keep(saved);
        name.set(undefined);
        toast(t("web.user.account.nameSaved"));
      }),
    );
  };
  const savePassword = () => {
    if (act.busy() || password() === "") return;
    const next = password();
    void act.run(() =>
      api.user.password.set({ password: next }).then((saved) => {
        keep(saved);
        password.set("");
        toast(t("web.user.account.passwordSaved"));
      }),
    );
  };

  return (
    <Card title={t("web.user.account.title")} testid="account">
      <If when={s()} else={<Quiet>{status.error() ? reasonOf(status.error()) : t("web.base.form.asking")}</Quiet>}>
        {(s) => (
          <View class="gap-4">
            <View class="flex-row flex-wrap items-end gap-2">
              <View class="min-w-48 flex-1">
                <Field label={t("web.user.account.name")} hint={t("web.user.account.nameHint")}>
                  <TextInput testID="account-name" accessibilityLabel={t("web.user.account.name")} value={shownName()} onInput={name.set} onSubmit={saveName} />
                </Field>
              </View>
              <Button testID="account-name-save" disabled={act.busy() || name() === undefined} onPress={saveName}>
                {t("web.user.account.save")}
              </Button>
            </View>
            <If when={s().here} else={<Text class="text-sm text-muted">{t("web.user.account.passwordHere")}</Text>}>
              <View class="flex-row flex-wrap items-end gap-2">
                <View class="min-w-48 flex-1">
                  <Field label={t("web.user.account.password")} hint={t("web.user.account.passwordHint")}>
                    <TextInput
                      testID="account-password"
                      accessibilityLabel={t("web.user.account.password")}
                      masked
                      value={password()}
                      onInput={password.set}
                      onSubmit={savePassword}
                    />
                  </Field>
                </View>
                <Button testID="account-password-save" disabled={act.busy() || password() === ""} onPress={savePassword}>
                  {s().password ? t("web.user.account.changePassword") : t("web.user.account.setPassword")}
                </Button>
              </View>
            </If>
            <If when={s().device}>
              {(device) => (
                <View class="flex-row flex-wrap items-end gap-2">
                  <Text class="min-w-48 flex-1 text-sm text-muted">{t("web.user.account.thisDevice", { name: device().name })}</Text>
                  <Button
                    testID="account-sign-out"
                    disabled={act.busy()}
                    onPress={() =>
                      void act.run(() => {
                        const back = device().came === "login" ? "/login" : "/pair";
                        return api.user.logout().then(() => router.navigate(back, { replace: true }));
                      })
                    }
                  >
                    {t("web.user.account.signOut")}
                  </Button>
                </View>
              )}
            </If>
          </View>
        )}
      </If>
    </Card>
  );
}
