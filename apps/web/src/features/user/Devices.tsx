import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { UserDevice } from "@vibevalley/protocol";

import { momentText } from "#/base/format.ts";
import { api } from "#/infra/api.ts";
import { ready, useQuery, useQueryClient } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Card } from "#/ui/layout.tsx";

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
  // Polled: a device paired or signed in elsewhere shows up without a reload.
  const devices = useQuery(devicesQuery, { interval: () => 5000 });
  const status = useQuery(userQuery);
  const act = createAct();
  const list = () => ready(devices, undefined) ?? [];
  const mine = () => ready(status, undefined)?.device?.id;
  return (
    <Show when={list().length > 0}>
      <Card
        title={t("web.user.devices.title")}
        testid="devices"
        action={<span class="text-sm text-muted">{t("web.user.devices.count", { n: list().length })}</span>}
      >
        <For each={list()}>
          {(d) => (
            <div data-key={d.id} data-came={d.came} class="flex items-center gap-2">
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-sm font-medium">{d.id === mine() ? t("web.user.devices.thisOne", { name: d.name }) : d.name}</span>
                <span class="truncate text-xs text-muted">{cameText(d)}</span>
              </span>
              <Button
                tone="danger"
                aria-label={t("web.user.devices.removeWhich", { name: d.name })}
                disabled={act.busy()}
                onClick={() =>
                  void act.run(() => {
                    // This device's own key is gone with it: nothing it asks next gets through.
                    const back = d.id === mine() ? (d.came === "login" ? "/login" : "/pair") : "";
                    return api.user.device.delete({ id: d.id }).then((left) => {
                      if (back !== "") location.replace(back);
                      else client.setData(devicesQuery(), () => ({ value: left }));
                    });
                  })
                }
              >
                {t("web.user.devices.remove")}
              </Button>
            </div>
          )}
        </For>
      </Card>
    </Show>
  );
}
