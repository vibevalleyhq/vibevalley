import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createExternal } from "#/base/external.ts";
import { VisionLine } from "#/features/voice/model/vision-line.ts";
import { canCapture, type VisualSource } from "#/features/voice/model/visual-capture.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { Select, TextArea } from "#/ui/Field.tsx";
import { Card } from "#/ui/layout.tsx";

const styles = stylex.create({
  field: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  controls: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "1rem",
  },
  notice: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.75rem",
  },
  problem: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-berry)",
  },
  prompt: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  finalTurn: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  transcript: {
    display: "flex",
    maxHeight: "18rem",
    flexDirection: "column",
    gap: "0.5rem",
    overflowY: "auto",
  },
  response: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    whiteSpace: "pre-wrap",
    color: "var(--color-ink)",
  },
  interrupted: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
});

function VisualSourceField(props: { source: VisualSource; disabled: boolean; onChange(source: VisualSource): void }) {
  return (
    <label {...stylex.attrs(styles.field)}>
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
        <div {...stylex.attrs(styles.controls)}>
          <p {...stylex.attrs(styles.notice)}>{t("web.voice.vision.notice")}</p>
          <p {...stylex.attrs(styles.notice)}>{t("web.voice.vision.hostNotice")}</p>
          <VisualSourceField source={source()} disabled={active() || props.sharing === true} onChange={(s) => props.onSource(s)} />
          <Show when={!canCapture(source())}>
            <p role="status" {...stylex.attrs(styles.notice)}>
              {t("web.voice.vision.unavailable")}
            </p>
          </Show>
          <div {...stylex.attrs(styles.actions)}>
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
            <p role="status" {...stylex.attrs(styles.notice)}>
              {status()}
            </p>
          </div>
          <Show when={problem()}>
            {(value) => (
              <p role="alert" {...stylex.attrs(styles.problem)}>
                {value()}
              </p>
            )}
          </Show>
          <form
            {...stylex.attrs(styles.prompt)}
            onSubmit={(event) => {
              event.preventDefault();
              if (line.prompt(prompt(), final())) setPrompt("");
            }}
          >
            <label {...stylex.attrs(styles.field)}>
              {t("web.voice.vision.prompt")}
              <TextArea data-testid="vision-prompt" rows={2} maxlength={8000} value={prompt()} onInput={(event) => void setPrompt(event.currentTarget.value)} />
            </label>
            <label {...stylex.attrs(styles.finalTurn)}>
              <Checkbox testid="vision-final" label={t("web.voice.vision.final")} checked={final()} onChange={setFinal} />
              {t("web.voice.vision.final")}
            </label>
            <Button data-testid="vision-send" type="submit" disabled={!session().readyForPrompt || !prompt().trim()}>
              {t("web.voice.vision.send")}
            </Button>
          </form>
          <Show when={session().lastEvent === "response.turn.silence"}>
            <p role="status" {...stylex.attrs(styles.notice)}>
              {t("web.voice.vision.silence")}
            </p>
          </Show>
          <div role="log" aria-label={t("web.voice.vision.transcript")} data-testid="vision-transcript" {...stylex.attrs(styles.transcript)}>
            <For each={session().responses}>
              {(response) => (
                <div data-state={response.state}>
                  <p {...stylex.attrs(styles.response)}>{response.text}</p>
                  <Show when={response.state === "interrupted"}>
                    <span {...stylex.attrs(styles.interrupted)}>{t("web.voice.vision.interrupted")}</span>
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
