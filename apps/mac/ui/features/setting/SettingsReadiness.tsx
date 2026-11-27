import { computed, Text, View } from "nsh";

import { list, t } from "@vibevalley/i18n";
import { type Feature, type Missing, type Readiness } from "@vibevalley/protocol";

import { Icon } from "../../design/Icon";
import { TextLink } from "../../design/TextLink";
import { ready, settingsQuery, useQuery } from "../../infra/query";
import { fixOf } from "../../infra/readiness";

type ReadinessRow =
  | { readonly key: string; readonly ready: true; readonly text: string }
  | { readonly key: string; readonly ready: false; readonly text: string; readonly fixHref?: string | undefined };

function buildReadinessRows(
  features: readonly Feature[],
  all: Record<Feature, Readiness>,
  options: { collapseSameReason?: boolean; selfHref?: string },
): ReadinessRow[] {
  const readyNames: string[] = [];
  const lackingByMissing = new Map<Missing, Feature[]>();
  const rows: ReadinessRow[] = [];

  if (options.collapseSameReason === true) {
    for (const f of features) {
      const state = all[f];
      if (state.ready) {
        readyNames.push(t(`web.setting.feature.${f}`));
      } else {
        const group = lackingByMissing.get(state.missing);
        if (group) group.push(f);
        else lackingByMissing.set(state.missing, [f]);
      }
    }
    if (readyNames.length > 0) {
      rows.push({
        key: `ready:${readyNames.join(",")}`,
        ready: true,
        text: t("web.setting.readiness.ready", { feature: list(readyNames) }),
      });
    }
    for (const [missing, group] of lackingByMissing) {
      const fix = fixOf(missing);
      rows.push({
        key: `lacks:${missing}`,
        ready: false,
        text: t("web.setting.readiness.lacks", {
          feature: list(group.map((f) => t(`web.setting.feature.${f}`))),
          why: fix.words,
        }),
        ...(fix.href !== options.selfHref ? { fixHref: fix.href } : {}),
      });
    }
    return rows;
  }

  for (const f of features) {
    const state = all[f];
    const name = t(`web.setting.feature.${f}`);
    if (state.ready) {
      rows.push({ key: `ready:${f}`, ready: true, text: t("web.setting.readiness.ready", { feature: name }) });
    } else {
      const fix = fixOf(state.missing);
      rows.push({
        key: `lacks:${f}`,
        ready: false,
        text: t("web.setting.readiness.lacks", { feature: name, why: fix.words }),
        ...(fix.href !== options.selfHref ? { fixHref: fix.href } : {}),
      });
    }
  }
  return rows;
}

export function SettingsReadiness(props: { features: readonly Feature[]; selfHref?: string; collapseSameReason?: boolean }) {
  const settings = useQuery(settingsQuery);
  const rows = computed(() => {
    const readiness = ready(settings, undefined)?.readiness;
    if (!readiness) return undefined;
    return buildReadinessRows(props.features, readiness, {
      ...(props.collapseSameReason !== undefined ? { collapseSameReason: props.collapseSameReason } : {}),
      ...(props.selfHref !== undefined ? { selfHref: props.selfHref } : {}),
    });
  });

  return (
    <If when={rows()}>
      {(items) => (
        <View class="gap-1.5 rounded-lg bg-side px-3.5 py-2.5" testID="readiness">
          <Each of={items()} key={(row) => row.key}>
            {(row) => {
              const fixHref = () => {
                const r = row();
                return !r.ready ? r.fixHref : undefined;
              };
              return (
                <View class="flex-row flex-wrap items-center gap-2" testID={row().ready ? "readiness-row-ready" : "readiness-row-lacking"}>
                  <If
                    when={!row().ready}
                    else={
                      <>
                        <Icon name="ticked" size={14} tone="leaf" />
                        <Text class="text-sm text-ink">{row().text}</Text>
                      </>
                    }
                  >
                    <Icon name="warn" size={14} />
                    <Text class="text-sm text-ink">{row().text}</Text>
                    <If when={fixHref()}>
                      {(href) => (
                        <TextLink href={href()} testid="readiness-fix">
                          {t("web.setting.readiness.fix")}
                        </TextLink>
                      )}
                    </If>
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
