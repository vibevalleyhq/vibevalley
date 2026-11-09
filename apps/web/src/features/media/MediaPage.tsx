import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { attachmentPath, type MediaImageRequest, type MediaImageJob } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { Link, useSearchParams } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { Field, Select, TextArea, TextInput } from "#/ui/Field.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";

import { AudioPanel } from "./AudioPanel.tsx";
import { publicationKey } from "./publication.ts";
import { SpeechPanel } from "./SpeechPanel.tsx";
import { UnderstandingPanel } from "./UnderstandingPanel.tsx";

const viewStyles = stylex.create({
  page: {
    display: "flex",
    height: "100%",
    minWidth: 0,
    flexDirection: "column",
    gap: "calc(var(--spacing) * 5)",
    overflowY: "auto",
    padding: "calc(var(--spacing) * 5)",
  },
  header: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "calc(var(--spacing) * 3)" },
  title: { fontSize: "var(--text-xl)", lineHeight: "var(--text-xl--line-height)", fontWeight: "var(--font-weight-semibold)" },
  link: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)", color: "var(--color-water)", textDecorationLine: "underline" },
  actions: { display: "flex", flexWrap: "wrap", gap: "calc(var(--spacing) * 2)" },
  content: { display: "flex", maxWidth: "var(--container-3xl)", minWidth: 0, flexDirection: "column", gap: "calc(var(--spacing) * 4)" },
  notice: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)", color: "var(--color-muted)" },
  form: { display: "flex", minWidth: 0, flexDirection: "column", gap: "calc(var(--spacing) * 3)" },
  dimensions: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "calc(var(--spacing) * 3)" },
  summary: { cursor: "pointer", fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" },
  advanced: { marginTop: "calc(var(--spacing) * 3)", display: "flex", flexDirection: "column", gap: "calc(var(--spacing) * 3)" },
  label: { display: "flex", alignItems: "center", gap: "calc(var(--spacing) * 2)", fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" },
  detail: { fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)", color: "var(--color-muted)" },
  error: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)", color: "var(--color-berry)" },
  heading: { fontSize: "var(--text-base)", lineHeight: "var(--text-base--line-height)", fontWeight: "var(--font-weight-semibold)" },
  identifierDetail: { fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)", wordBreak: "break-all", color: "var(--color-muted)" },
  source: { fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)", overflowWrap: "break-word", color: "var(--color-muted)" },
  prose: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)", overflowWrap: "break-word", whiteSpace: "pre-wrap" },
  image: { maxHeight: "calc(var(--spacing) * 96)", maxWidth: "100%", borderRadius: "var(--radius-md)", objectFit: "contain" },
});

export function MediaPage() {
  const state = useCore();
  const [search, setSearch] = useSearchParams();
  const mode = () => {
    const selected = search().get("mode");
    return selected === "speech" || selected === "understanding" || selected === "audio" ? selected : "image";
  };
  const images = () => state()?.media?.filter((job) => job.kind === "image") ?? [];
  const [prompt, setPrompt] = createSignal("");
  const [format, setFormat] = createSignal<"text" | "layout">("text");
  const [width, setWidth] = createSignal(1024);
  const [height, setHeight] = createSignal(1024);
  const [seed, setSeed] = createSignal("");
  const [steps, setSteps] = createSignal("");
  const [guidance, setGuidance] = createSignal("");
  const [negative, setNegative] = createSignal("");
  const [enhance, setEnhance] = createSignal(false);
  const [watermark, setWatermark] = createSignal(true);
  const [submitted, setSubmitted] = createSignal<MediaImageRequest>();
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const submit = () => {
    const input = submitted() ?? {
      id: crypto.randomUUID(),
      prompt: prompt(),
      format: format(),
      width: width(),
      height: height(),
      enhance: enhance(),
      watermark: watermark(),
      ...(seed() !== "" ? { seed: Number(seed()) } : {}),
      ...(steps() !== "" ? { steps: Number(steps()) } : {}),
      ...(guidance() !== "" ? { guidance: Number(guidance()) } : {}),
      ...(negative() !== "" ? { negativePrompt: negative() } : {}),
    };
    setSubmitted(input);
    return act.run(() => api.media.image.create(input));
  };
  return (
    <div {...stylex.attrs(viewStyles.page)} data-testid="media-page">
      <div {...stylex.attrs(viewStyles.header)}>
        <h1 {...stylex.attrs(viewStyles.title)}>{t("web.media.title")}</h1>
        <Link href="/settings/providers" {...stylex.attrs(viewStyles.link)}>
          {t("web.media.configure")}
        </Link>
      </div>
      <div {...stylex.attrs(viewStyles.actions)}>
        <Button
          data-testid="media-mode-image"
          aria-pressed={mode() === "image" ? "true" : "false"}
          tone={mode() === "image" ? "primary" : "plain"}
          onClick={() => setSearch({ mode: "image" })}
        >
          {t("web.media.image")}
        </Button>
        <Button
          data-testid="media-mode-understanding"
          aria-pressed={mode() === "understanding" ? "true" : "false"}
          tone={mode() === "understanding" ? "primary" : "plain"}
          onClick={() => setSearch({ mode: "understanding" })}
        >
          {t("web.media.understanding.title")}
        </Button>
        <Button
          data-testid="media-mode-speech"
          aria-pressed={mode() === "speech" ? "true" : "false"}
          tone={mode() === "speech" ? "primary" : "plain"}
          onClick={() => setSearch({ mode: "speech" })}
        >
          {t("web.media.speech.title")}
        </Button>
        <Button
          data-testid="media-mode-audio"
          aria-pressed={mode() === "audio" ? "true" : "false"}
          tone={mode() === "audio" ? "primary" : "plain"}
          onClick={() => setSearch({ mode: "audio" })}
        >
          {t("web.audio.title")}
        </Button>
      </div>
      <div {...stylex.attrs(viewStyles.content)}>
        <Show when={mode() === "audio"}>
          <AudioPanel />
        </Show>
        <Show when={mode() === "speech"}>
          <SpeechPanel />
        </Show>
        <Show when={mode() === "understanding"}>
          <UnderstandingPanel />
        </Show>
        <Show when={mode() === "image"}>
          <Card title={t("web.media.generate")}>
            <p {...stylex.attrs(viewStyles.notice)}>{t("web.media.notice")}</p>
            <fieldset disabled={act.busy() || submitted() !== undefined} {...stylex.attrs(viewStyles.form)} aria-label={t("web.media.prompt")}>
              <Field label={t("web.media.format")}>
                <Select
                  label={t("web.media.format")}
                  testid="media-format"
                  value={format()}
                  onChange={setFormat}
                  options={[
                    { value: "text", label: t("web.media.text") },
                    { value: "layout", label: t("web.media.layout") },
                  ]}
                />
              </Field>
              <Field label={t("web.media.prompt")}>
                <TextArea
                  data-testid="media-prompt"
                  aria-label={t("web.media.prompt")}
                  rows={5}
                  value={prompt()}
                  onInput={(event) => setPrompt(event.currentTarget.value)}
                />
              </Field>
              <div {...stylex.attrs(viewStyles.dimensions)}>
                <Field label={t("web.media.width")}>
                  <TextInput
                    data-testid="media-width"
                    aria-label={t("web.media.width")}
                    type="number"
                    value={width()}
                    onInput={(e) => setWidth(Number(e.currentTarget.value))}
                  />
                </Field>
                <Field label={t("web.media.height")}>
                  <TextInput
                    data-testid="media-height"
                    aria-label={t("web.media.height")}
                    type="number"
                    value={height()}
                    onInput={(e) => setHeight(Number(e.currentTarget.value))}
                  />
                </Field>
              </div>
              <details>
                <summary {...stylex.attrs(viewStyles.summary)}>{t("web.media.advanced")}</summary>
                <div {...stylex.attrs(viewStyles.advanced)}>
                  <Field label={t("web.media.seed")}>
                    <TextInput aria-label={t("web.media.seed")} type="number" value={seed()} onInput={(e) => setSeed(e.currentTarget.value)} />
                  </Field>
                  <Field label={t("web.media.steps")}>
                    <TextInput aria-label={t("web.media.steps")} type="number" value={steps()} onInput={(e) => setSteps(e.currentTarget.value)} />
                  </Field>
                  <Field label={t("web.media.guidance")}>
                    <TextInput
                      aria-label={t("web.media.guidance")}
                      type="number"
                      step="any"
                      value={guidance()}
                      onInput={(e) => setGuidance(e.currentTarget.value)}
                    />
                  </Field>
                  <Field label={t("web.media.negative")}>
                    <TextArea aria-label={t("web.media.negative")} value={negative()} onInput={(e) => setNegative(e.currentTarget.value)} />
                  </Field>
                  <label {...stylex.attrs(viewStyles.label)}>
                    <Checkbox label={t("web.media.enhance")} checked={enhance()} onChange={setEnhance} />
                    {t("web.media.enhance")}
                  </label>
                  <label {...stylex.attrs(viewStyles.label)}>
                    <Checkbox label={t("web.media.watermark")} checked={watermark()} onChange={setWatermark} />
                    {t("web.media.watermark")}
                  </label>
                </div>
              </details>
            </fieldset>
            <Show when={submitted()}>
              <p {...stylex.attrs(viewStyles.detail)}>{t("web.media.pending")}</p>
            </Show>
            <div {...stylex.attrs(viewStyles.actions)}>
              <Button data-testid="media-generate" tone="primary" disabled={act.busy() || !prompt().trim()} onClick={() => void submit()}>
                {submitted() ? t("web.media.resubmit") : t("web.media.generate")}
              </Button>
              <Show when={submitted()}>
                <ConfirmButton
                  testid="media-new"
                  tone="primary"
                  label={t("web.media.new")}
                  question={t("web.media.newAsk")}
                  disabled={act.busy()}
                  onConfirm={() => {
                    setSubmitted(undefined);
                    setError(undefined);
                  }}
                />
              </Show>
            </div>
            <Show when={error()}>
              {(why) => (
                <p role="alert" data-testid="media-error" {...stylex.attrs(viewStyles.error)}>
                  {why()}
                </p>
              )}
            </Show>
          </Card>
          <h2 {...stylex.attrs(viewStyles.heading)}>{t("web.media.history")}</h2>
          <Show when={images().length > 0} fallback={<Quiet>{t("web.media.empty")}</Quiet>}>
            <For each={images()} keyed={(job) => job.id}>
              {(job) => <JobCard job={job()} />}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function JobCard(props: { job: MediaImageJob }) {
  const state = useCore();
  const [error, setError] = createSignal<string>();
  const [channel, setChannel] = createSignal("");
  const [posted, setPosted] = createSignal(false);
  const act = createAct(setError);
  const cancel = () => {
    const id = props.job.id;
    return act.run(() => api.media.job.cancel({ id }));
  };
  const retry = () => {
    const id = props.job.id;
    return act.run(() => api.media.job.download({ id }));
  };
  const publish = (attachment: string) => {
    const id = channel();
    const text = props.job.prompt;
    const job = props.job.id;
    return act.run(async () => {
      const sendKey = await publicationKey(job, id);
      await api.channel.message.send({ id, text, attachments: [attachment], sendKey });
      setPosted(true);
    });
  };
  return (
    <Card title={props.job.phaseText}>
      <div data-testid="media-job" data-id={props.job.id} data-phase={props.job.phase} {...stylex.attrs(viewStyles.form)}>
        <p {...stylex.attrs(viewStyles.identifierDetail)}>
          {props.job.model} · {props.job.id}
        </p>
        <p data-testid="media-source" {...stylex.attrs(viewStyles.source)}>
          {props.job.source.kind === "owner"
            ? t("web.media.sourceOwner")
            : t("web.media.sourceAgent", { agent: props.job.source.agent, channel: props.job.source.channel })}
        </p>
        <p data-testid="media-usage" {...stylex.attrs(viewStyles.detail)}>
          {props.job.usage ? t("web.media.usage", props.job.usage) : t("web.media.usageUnknown")}
        </p>
        <p {...stylex.attrs(viewStyles.prose)}>{props.job.prompt}</p>
        <Show when={props.job.problem}>
          <p {...stylex.attrs(viewStyles.notice)}>{props.job.problem}</p>
        </Show>
        <Show when={props.job.attachment}>
          {(file) => (
            <>
              <img data-testid="media-image" src={attachmentPath(file().id)} alt={props.job.prompt} {...stylex.attrs(viewStyles.image)} />
              <a data-testid="media-save" href={attachmentPath(file().id)} download={file().name} {...stylex.attrs(viewStyles.link)}>
                {t("web.media.save")}
              </a>
              <Field label={t("web.media.channel")}>
                <Select
                  label={t("web.media.channel")}
                  testid="media-channel"
                  disabled={act.busy()}
                  placeholder={t("web.media.chooseChannel")}
                  value={channel()}
                  onChange={(value) => {
                    setChannel(value);
                    setPosted(false);
                  }}
                  options={(state()?.chat?.channels ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
                />
              </Field>
              <Button
                data-testid="media-publish"
                data-published={posted() ? "true" : "false"}
                disabled={act.busy() || !channel() || posted()}
                onClick={() => void publish(file().id)}
              >
                {posted() ? t("web.media.published") : t("web.media.publish")}
              </Button>
            </>
          )}
        </Show>
        <div {...stylex.attrs(viewStyles.actions)}>
          <Show when={props.job.canCancel}>
            <ConfirmButton
              testid="media-cancel"
              label={t("web.media.cancel")}
              question={t("web.media.cancelAsk")}
              disabled={act.busy()}
              onConfirm={() => void cancel()}
            />
          </Show>
          <Show when={props.job.canRetryDownload}>
            <Button data-testid="media-retry-download" disabled={act.busy()} onClick={() => void retry()}>
              {t("web.media.retry")}
            </Button>
          </Show>
        </div>
        <Show when={error()}>
          {(why) => (
            <p role="alert" {...stylex.attrs(viewStyles.error)}>
              {why()}
            </p>
          )}
        </Show>
      </div>
    </Card>
  );
}
