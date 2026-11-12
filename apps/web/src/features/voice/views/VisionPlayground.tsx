import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createExternal } from "#/base/external.ts";
import { VisionLine } from "#/features/voice/model/vision-line.ts";
import { canCapture, type VisualSource } from "#/features/voice/model/visual-capture.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { Select, TextArea } from "#/ui/Field.tsx";
import { Card } from "#/ui/layout.tsx";

function VisualSourceField(props: { source: VisualSource; disabled: boolean; onChange(source: VisualSource): void }) {
  return (
    <label class="flex flex-col gap-1 text-xs text-muted">
      {t("web.voice.vision.source")}
      <Select<VisualSource>
        testid="visual-source"
        label={t("web.voice.vision.source")}
        value={props.source}
        disabled={props.disabled}
        onChange={(source) => props.onChange(source)}
        options={[
          { value: "camera", label: t("web.voice.vision.camera"), disabled: !canCapture("camera") },
          { value: "screen", label: t("web.voice.vision.screen"), disabled: !canCapture("screen") },
        ]}
      />
    </label>
  );
}

/** Asking about a picture on its own, and (where a Live call is) sharing the same picture with the call: one source for
 * both, chosen once; it holds while either uses it. */
export function VisionPlayground(props: { source: VisualSource; onSource: (source: VisualSource) => void; sharing?: boolean; liveShare?: JSX.Element }) {
  const line = new VisionLine();
  const version = createExternal(line.subscribe, () => line.version);
  const session = () => (version(), line.session);
  const source = () => props.source;
  const [prompt, setPrompt] = createSignal("");
  const [final, setFinal] = createSignal(false);
  const active = () => session().phase === "connecting" || session().phase === "ready";
  const problem = () => (version(), line.problem ?? (session().problem ? t("web.voice.vision.closed") : undefined));
  const status = () => {
    switch (session().phase) {
      case "idle":
        return t("web.voice.vision.idle");
      case "connecting":
        return t("web.voice.vision.connecting");
      case "ready":
        return t("web.voice.vision.ready");
      case "ended":
        return t("web.voice.vision.ended");
      case "error":
        return t("web.voice.vision.error");
    }
  };
  onSettled(() => () => line.stop());
  return (
    <section data-testid="vision-line" data-state={session().phase}>
      <Card title={t("web.voice.vision.title")}>
        <div class="flex flex-col gap-3 p-4">
          <p class="text-sm text-muted">{t("web.voice.vision.notice")}</p>
          <p class="text-sm text-muted">{t("web.voice.vision.hostNotice")}</p>
          <VisualSourceField source={source()} disabled={active() || props.sharing === true} onChange={(s) => props.onSource(s)} />
          <Show when={!canCapture(source())}>
            <p role="status" class="text-sm text-muted">
              {t("web.voice.vision.unavailable")}
            </p>
          </Show>
          <div class="flex flex-wrap items-center gap-3">
            <Show
              when={active()}
              fallback={
                <Button data-testid="vision-start" tone="primary" disabled={!canCapture(source())} onClick={() => void line.start(source())}>
                  {t("web.voice.vision.start")}
                </Button>
              }
            >
              <Button data-testid="vision-stop" tone="danger" onClick={() => line.stop()}>
                {t("web.voice.vision.stop")}
              </Button>
            </Show>
            <p role="status" class="text-sm text-muted">
              {status()}
            </p>
          </div>
          <Show when={problem()}>
            {(value) => (
              <p role="alert" class="text-sm text-berry">
                {value()}
              </p>
            )}
          </Show>
          <form
            class="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (line.prompt(prompt(), final())) setPrompt("");
            }}
          >
            <label class="flex flex-col gap-1 text-xs text-muted">
              {t("web.voice.vision.prompt")}
              <TextArea data-testid="vision-prompt" rows={2} maxlength={8000} value={prompt()} onInput={(event) => void setPrompt(event.currentTarget.value)} />
            </label>
            <label class="flex items-center gap-2 text-sm text-muted">
              <Checkbox testid="vision-final" label={t("web.voice.vision.final")} checked={final()} onChange={setFinal} />
              {t("web.voice.vision.final")}
            </label>
            <Button data-testid="vision-send" type="submit" disabled={!session().readyForPrompt || !prompt().trim()}>
              {t("web.voice.vision.send")}
            </Button>
          </form>
          <Show when={session().lastEvent === "response.turn.silence"}>
            <p role="status" class="text-sm text-muted">
              {t("web.voice.vision.silence")}
            </p>
          </Show>
          <div role="log" aria-label={t("web.voice.vision.transcript")} data-testid="vision-transcript" class="flex max-h-72 flex-col gap-2 overflow-y-auto">
            <For each={session().responses}>
              {(response) => (
                <div data-state={response.state}>
                  <p class="text-sm whitespace-pre-wrap text-ink">{response.text}</p>
                  <Show when={response.state === "interrupted"}>
                    <span class="text-xs text-muted">{t("web.voice.vision.interrupted")}</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
          {props.liveShare}
        </div>
      </Card>
    </section>
  );
}
