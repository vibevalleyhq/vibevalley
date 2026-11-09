import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Preview } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";

export function ReleaseAssets(props: { id: string }) {
  const [preview, setPreview] = createSignal<Preview>();
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <Button
        data-testid="media-preview-release"
        disabled={act.busy()}
        onClick={() => {
          const id = props.id;
          void act.run(async () => setPreview(await api.media.job.previewRelease({ id })));
        }}
      >
        {t("web.media.releasePreview")}
      </Button>
      <Show when={preview()}>
        {(value) => (
          <>
            <ul data-testid="media-release-preview" class="list-inside list-disc text-sm text-muted">
              <For each={value().does}>{(step) => <li class="break-words">{step}</li>}</For>
            </ul>
            <ConfirmButton
              testid="media-release"
              label={t("web.media.release")}
              question={t("web.media.releaseAsk")}
              disabled={act.busy()}
              onConfirm={() => {
                const id = props.id;
                void act.run(async () => {
                  await api.media.job.release({ id });
                  setPreview(undefined);
                });
              }}
            />
          </>
        )}
      </Show>
      <Show when={error()}>
        {(reason) => (
          <p role="alert" class="text-sm text-berry">
            {reason()}
          </p>
        )}
      </Show>
    </div>
  );
}
