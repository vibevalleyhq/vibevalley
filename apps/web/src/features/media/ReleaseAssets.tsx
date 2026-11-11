import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Preview } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";

const viewStyles = stylex.create({
  stack: { display: "flex", minWidth: 0, flexDirection: "column", gap: "0.5rem" },
  preview: {
    listStylePosition: "inside",
    listStyleType: "disc",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  wrapText: { overflowWrap: "break-word" },
  error: { fontSize: "var(--text-sm)", lineHeight: "var(--leading-sm)", color: "var(--color-berry)" },
});

export function ReleaseAssets(props: { id: string }) {
  const [preview, setPreview] = createSignal<Preview>();
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  return (
    <div {...stylex.attrs(viewStyles.stack)}>
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
            <ul data-testid="media-release-preview" {...stylex.attrs(viewStyles.preview)}>
              <For each={value().does}>{(step) => <li {...stylex.attrs(viewStyles.wrapText)}>{step}</li>}</For>
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
          <p role="alert" {...stylex.attrs(viewStyles.error)}>
            {reason()}
          </p>
        )}
      </Show>
    </div>
  );
}
