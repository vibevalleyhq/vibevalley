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
    <div class="flex h-full min-w-0 flex-col gap-5 overflow-y-auto p-5" data-testid="media-page">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold">{t("web.media.title")}</h1>
        <Link href="/settings/providers" class="text-sm text-water underline">
          {t("web.media.configure")}
        </Link>
      </div>
      <div class="flex flex-wrap gap-2">
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
      <div class="flex max-w-3xl min-w-0 flex-col gap-4">
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
            <p class="text-sm text-muted">{t("web.media.notice")}</p>
            <fieldset disabled={act.busy() || submitted() !== undefined} class="flex min-w-0 flex-col gap-3" aria-label={t("web.media.prompt")}>
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
              <div class="grid grid-cols-2 gap-3">
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
                <summary class="cursor-pointer text-sm">{t("web.media.advanced")}</summary>
                <div class="mt-3 flex flex-col gap-3">
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
                  <label class="flex items-center gap-2 text-sm">
                    <Checkbox label={t("web.media.enhance")} checked={enhance()} onChange={setEnhance} />
                    {t("web.media.enhance")}
                  </label>
                  <label class="flex items-center gap-2 text-sm">
                    <Checkbox label={t("web.media.watermark")} checked={watermark()} onChange={setWatermark} />
                    {t("web.media.watermark")}
                  </label>
                </div>
              </details>
            </fieldset>
            <Show when={submitted()}>
              <p class="text-xs text-muted">{t("web.media.pending")}</p>
            </Show>
            <div class="flex flex-wrap gap-2">
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
                <p role="alert" data-testid="media-error" class="text-sm text-berry">
                  {why()}
                </p>
              )}
            </Show>
          </Card>
          <h2 class="text-base font-semibold">{t("web.media.history")}</h2>
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
      <div data-testid="media-job" data-id={props.job.id} data-phase={props.job.phase} class="flex min-w-0 flex-col gap-3">
        <p class="text-xs break-all text-muted">
          {props.job.model} · {props.job.id}
        </p>
        <p data-testid="media-source" class="text-xs break-words text-muted">
          {props.job.source.kind === "owner"
            ? t("web.media.sourceOwner")
            : t("web.media.sourceAgent", { agent: props.job.source.agent, channel: props.job.source.channel })}
        </p>
        <p data-testid="media-usage" class="text-xs text-muted">
          {props.job.usage ? t("web.media.usage", props.job.usage) : t("web.media.usageUnknown")}
        </p>
        <p class="text-sm break-words whitespace-pre-wrap">{props.job.prompt}</p>
        <Show when={props.job.problem}>
          <p class="text-sm text-muted">{props.job.problem}</p>
        </Show>
        <Show when={props.job.attachment}>
          {(file) => (
            <>
              <img data-testid="media-image" src={attachmentPath(file().id)} alt={props.job.prompt} class="max-h-96 max-w-full rounded-md object-contain" />
              <a data-testid="media-save" href={attachmentPath(file().id)} download={file().name} class="text-sm text-water underline">
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
        <div class="flex flex-wrap gap-2">
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
            <p role="alert" class="text-sm text-berry">
              {why()}
            </p>
          )}
        </Show>
      </div>
    </Card>
  );
}
