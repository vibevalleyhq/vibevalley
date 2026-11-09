import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Feature } from "@vibevalley/protocol";

import { ready, settingsQuery, useQuery } from "#/infra/query.ts";
import { fixOf } from "#/infra/readiness.ts";
import { Icon } from "#/ui/Icon.tsx";
import { TextLink } from "#/ui/layout.tsx";

const styles = stylex.create({
  lines: { display: "flex", flexDirection: "column", gap: "var(--spacing)" },
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  ready: { color: "var(--color-leaf)" },
  lacking: { color: "var(--color-berry)" },
});

/** Whether the features a page sets up can be used now, as the server says (SettingsStatus.readiness), and where to
 * fix the ones that cannot. Says nothing while the settings are on their way. */
export function Readiness(props: { features: readonly Feature[] }) {
  const settings = useQuery(settingsQuery);
  const readiness = () => ready(settings, undefined)?.readiness;
  return (
    <Show when={readiness()}>
      {(all) => (
        <div {...stylex.attrs(styles.lines)} data-testid="readiness">
          <For each={props.features}>
            {(feature) => {
              const state = () => all()[feature];
              const name = t(`web.setting.feature.${feature}`);
              const lacking = () => {
                const now = state();
                return now.ready ? undefined : now.missing;
              };
              return (
                <div {...stylex.attrs(styles.line)} data-key={feature} data-state={state().ready ? "ready" : "lacking"}>
                  <Show
                    when={lacking()}
                    fallback={
                      <>
                        <span {...stylex.attrs(styles.ready)}>
                          <Icon name="ticked" size={14} />
                        </span>
                        {t("web.setting.readiness.ready", { feature: name })}
                      </>
                    }
                  >
                    {(missing) => (
                      <>
                        <span {...stylex.attrs(styles.lacking)}>
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
