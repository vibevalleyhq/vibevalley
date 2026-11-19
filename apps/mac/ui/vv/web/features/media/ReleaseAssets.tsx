// Ported from VibeValley apps/web/src/features/media/ReleaseAssets.tsx.
import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Preview } from "@vibevalley/protocol";

import { api } from "../../infra/api";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";

export function ReleaseAssets(props: { id: string }) {
  const preview = signal<Preview | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  return (
    <View class="min-w-0 gap-2">
      <Button
        testID="media-preview-release"
        disabled={act.busy()}
        onPress={() => {
          const id = props.id;
          void act.run(async () => preview.set(await api.media.job.previewRelease({ id })));
        }}
      >
        {t("web.media.releasePreview")}
      </Button>
      <If when={preview()}>
        {(value) => (
          <>
            <View testID="media-release-preview" class="gap-1">
              <Each of={value().does}>{(step) => <Text class="text-sm text-muted">{`• ${step()}`}</Text>}</Each>
            </View>
            <ConfirmButton
              testid="media-release"
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
          </>
        )}
      </If>
      <If when={error()}>
        {(reason) => (
          <Text role="alert" class="text-sm text-berry">
            {reason()}
          </Text>
        )}
      </If>
    </View>
  );
}
