import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Preview } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { ConfirmButton } from "../../design/ConfirmButton";
import { Icon } from "../../design/Icon";
import { motionClass } from "../../design/motion";
import { CountPill, Dot } from "../../design/Tag";
import { createAct } from "../../infra/act";
import { api } from "../../infra/api";
import { Refusal } from "./JobFacts";

export function ReleaseAssets(props: { id: string }) {
  const preview = signal<Preview | undefined>(undefined);
  const open = signal(true);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  return (
    <View class="min-w-0 gap-2">
      <View class="flex-row flex-wrap items-center gap-2">
        <Button
          testID="media-preview-release"
          icon="show"
          disabled={act.busy()}
          onPress={() => {
            const id = props.id;
            void act.run(async () => {
              preview.set(await api.media.job.previewRelease({ id }));
              open.set(true);
            });
          }}
        >
          {t("web.media.releasePreview")}
        </Button>
      </View>
      <If when={preview()}>
        {(value) => (
          <View class="min-w-0 gap-2.5 rounded-md bg-side p-3">
            <View
              role="button"
              accessibilityState={{ expanded: open() }}
              onPress={() => open.set(!open())}
              class="flex-row items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-hover"
            >
              <View
                class={`h-3.5 w-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
                style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
              >
                <Icon name="expand" size={10} tone="muted" />
              </View>
              <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{t("web.media.releasePreview")}</Text>
              <CountPill count={value().does.length} />
            </View>
            <If when={open()}>
              <View testID="media-release-preview" class="gap-1 pl-5.5">
                <Each of={value().does}>
                  {(step) => (
                    <View class="flex-row items-start gap-2 rounded-sm bg-page px-2.5 py-1.5">
                      <View class="mt-1.5 shrink-0">
                        <Dot tone="muted" size={5} ring={false} />
                      </View>
                      <Text class="min-w-0 flex-1 text-xs leading-relaxed text-ink tabular-nums">{step()}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
            <View class="flex-row flex-wrap items-center gap-2 pl-5.5">
              <ConfirmButton
                testid="media-release"
                tone="danger"
                icon="delete"
                label={t("web.media.release")}
                question={t("web.media.releaseAsk")}
                disabled={act.busy()}
                onConfirm={() => {
                  const id = props.id;
                  void act.run(async () => {
                    await api.media.job.release({ id });
                    preview.set(undefined);
                  });
                }}
              />
              <Button tone="quiet" disabled={act.busy()} onPress={() => preview.set(undefined)}>
                {t("web.base.form.never")}
              </Button>
            </View>
          </View>
        )}
      </If>
      <Refusal error={error()} />
    </View>
  );
}
