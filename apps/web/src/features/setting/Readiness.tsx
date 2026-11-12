import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Feature } from "@vibevalley/protocol";

import { ready, settingsQuery, useQuery } from "#/infra/query.ts";
import { fixOf } from "#/infra/readiness.ts";
import { Icon } from "#/ui/Icon.tsx";
import { TextLink } from "#/ui/layout.tsx";

/** Whether the features a page sets up can be used now, as the server says (SettingsStatus.readiness), and where to
 * fix the ones that cannot. Says nothing while the settings are on their way. */
export function Readiness(props: { features: readonly Feature[] }) {
  const settings = useQuery(settingsQuery);
  const readiness = () => ready(settings, undefined)?.readiness;
  return (
    <Show when={readiness()}>
      {(all) => (
        <div class="flex flex-col gap-1" data-testid="readiness">
          <For each={props.features}>
            {(feature) => {
              const state = () => all()[feature];
              const name = t(`web.setting.feature.${feature}`);
              const lacking = () => {
                const now = state();
                return now.ready ? undefined : now.missing;
              };
              return (
                <div class="flex flex-wrap items-center gap-2 text-sm" data-key={feature} data-state={state().ready ? "ready" : "lacking"}>
                  <Show
                    when={lacking()}
                    fallback={
                      <>
                        <span class="text-leaf">
                          <Icon name="ticked" size={14} />
                        </span>
                        {t("web.setting.readiness.ready", { feature: name })}
                      </>
                    }
                  >
                    {(missing) => (
                      <>
                        <span class="text-berry">
                          <Icon name="warn" size={14} />
                        </span>
                        {t("web.setting.readiness.lacks", { feature: name, why: fixOf(missing()).words })}
                        <TextLink href={fixOf(missing()).href}>{t("web.setting.readiness.fix")}</TextLink>
                      </>
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      )}
    </Show>
  );
}
