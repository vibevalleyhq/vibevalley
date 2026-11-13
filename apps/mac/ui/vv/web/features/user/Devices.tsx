// Ported from VibeValley apps/web/src/features/user/Devices.tsx. Taking this
// device's own key back goes to the sign-in or pairing page through the router.
import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { UserDevice } from "@vibevalley/protocol";

import { momentText } from "../../base/format";
import { api } from "../../infra/api";
import { ready, useQuery, useQueryClient } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/layout";
import { devicesQuery, userQuery } from "./signIns";

/** When it came and when it was last seen, said by how it came: paired, or signed in. */
const cameText = (d: UserDevice) => {
  const at = momentText(d.addedAt);
  const last = d.lastSeen ?? 0;
  if (d.came === "login") return last !== 0 ? t("web.user.devices.login", { at, seen: momentText(last) }) : t("web.user.devices.loginNever", { at });
  return last !== 0 ? t("web.user.devices.paired", { at, seen: momentText(last) }) : t("web.user.devices.pairedNever", { at });
};

/** Every device holding a key, paired or signed in; taking one's key back cuts what it has open. */
export function Devices() {
  const client = useQueryClient();
  const router = useRouter();
  // Polled: a device paired or signed in elsewhere shows up without a reload.
  const devices = useQuery(devicesQuery, { interval: () => 5000 });
  const status = useQuery(userQuery);
  const act = createAct();
  const list = () => ready(devices, undefined) ?? [];
  const mine = () => ready(status, undefined)?.device?.id;
  return (
    <If when={list().length > 0}>
      <Card
        title={t("web.user.devices.title")}
        testid="devices"
        action={<Text class="text-sm text-muted">{t("web.user.devices.count", { n: list().length })}</Text>}
      >
        <Each of={list()} key={(d) => d.id}>
          {(d) => (
            <View testID={`device-${d().id}`} class="flex-row items-center gap-2">
              <View class="min-w-0 flex-1">
                <Text class="truncate text-sm font-medium text-ink">{d().id === mine() ? t("web.user.devices.thisOne", { name: d().name }) : d().name}</Text>
                <Text class="truncate text-xs text-muted">{cameText(d())}</Text>
              </View>
              <Button
                tone="danger"
                testID="device-remove"
                accessibilityLabel={t("web.user.devices.removeWhich", { name: d().name })}
                disabled={act.busy()}
                onPress={() =>
                  void act.run(() => {
                    const device = d();
                    // This device's own key is gone with it: nothing it asks next gets through.
                    const back = device.id === mine() ? (device.came === "login" ? "/login" : "/pair") : "";
                    return api.user.device.delete({ id: device.id }).then((left) => {
                      if (back !== "") router.navigate(back, { replace: true });
                      else client.setData(devicesQuery(), () => ({ value: left }));
                    });
                  })
                }
              >
                {t("web.user.devices.remove")}
              </Button>
            </View>
          )}
        </Each>
      </Card>
    </If>
  );
}
