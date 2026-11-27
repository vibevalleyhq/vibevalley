import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Feature } from "@vibevalley/protocol";

import { useDesignHost } from "../host";
import { Icon } from "../Icon";
import { TextLink } from "../TextLink";

/** Whether the features a page sets up can be used now, as the server says (SettingsStatus.readiness), and where to
 * fix the ones that cannot. Says nothing while the settings are on their way. */
export function Readiness(props: { features: readonly Feature[] }) {
  const designHost = useDesignHost();
  const settings = designHost.useSettings();
  const readiness = () => settings()?.readiness;
  return (
    <If when={readiness()}>
      {(all) => (
        <View class="gap-1.5 rounded-lg bg-side px-3.5 py-2.5" testID="readiness">
          <Each of={props.features} key={(feature) => feature}>
            {(feature) => {
              const state = () => all()[feature()];
              const name = () => t(`web.setting.feature.${feature()}`);
              const lacking = () => {
                const now = state();
                return now.ready ? undefined : now.missing;
              };
              return (
                <View class="flex-row flex-wrap items-center gap-2" testID={`readiness-${feature()}-${state().ready ? "ready" : "lacking"}`}>
                  <If
                    when={lacking()}
                    else={
                      <>
                        <Icon name="ticked" size={14} tone="leaf" />
                        <Text class="text-sm text-ink">{t("web.setting.readiness.ready", { feature: name() })}</Text>
                      </>
                    }
                  >
                    {(missing) => (
                      <>
                        <Icon name="warn" size={14} />
                        <Text class="text-sm text-ink">
                          {t("web.setting.readiness.lacks", { feature: name(), why: designHost.readinessFix(missing()).words })}
                        </Text>
                        <TextLink href={designHost.readinessFix(missing()).href}>{t("web.setting.readiness.fix")}</TextLink>
                      </>
                    )}
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      )}
    </If>
  );
}
