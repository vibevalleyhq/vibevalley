import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import {
  attachmentPath,
  mediaInputContentPath,
  MediaAudioFormatValues,
  type MediaAudioFormat,
  type MediaSpeechJob,
  type MediaSpeechRequest,
  type ProviderVoiceRequest,
} from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { api, reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { defineQuery, providerQuery, ready, useQuery } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { Field, Select, TextArea } from "#/ui/Field.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";

import { FlashPlayer } from "./FlashPlayer.tsx";
import { publicationKey } from "./publication.ts";
import { ReleaseAssets } from "./ReleaseAssets.tsx";

const viewStyles = stylex.create({
  section: { display: "flex", minWidth: 0, flexDirection: "column", gap: "1rem" },
  notice: { fontSize: "var(--text-sm)", lineHeight: "var(--leading-sm)", color: "var(--color-muted)" },
  identifierDetail: { fontSize: "var(--text-xs)", lineHeight: "var(--leading-xs)", wordBreak: "break-all", color: "var(--color-muted)" },
  form: { display: "flex", minWidth: 0, flexDirection: "column", gap: "0.75rem" },
  actions: { display: "flex", flexWrap: "wrap", gap: "0.5rem" },
  error: { fontSize: "var(--text-sm)", lineHeight: "var(--leading-sm)", color: "var(--color-berry)" },
  stack: { display: "flex", minWidth: 0, flexDirection: "column", gap: "0.5rem" },
  detail: { fontSize: "var(--text-xs)", lineHeight: "var(--leading-xs)", color: "var(--color-muted)" },
  heading: { fontSize: "var(--text-base)", lineHeight: "var(--leading-base)", fontWeight: "var(--font-weight-semibold)" },
  player: { width: "100%", maxWidth: "100%", minWidth: 0 },
  source: { fontSize: "var(--text-xs)", lineHeight: "var(--leading-xs)", overflowWrap: "break-word", color: "var(--color-muted)" },
  metadata: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  prose: { fontSize: "var(--text-sm)", lineHeight: "var(--leading-sm)", overflowWrap: "break-word", whiteSpace: "pre-wrap" },
  link: { fontSize: "var(--text-sm)", lineHeight: "var(--leading-sm)", color: "var(--color-water)", textDecorationLine: "underline" },
});

const voicesQuery = defineQuery({
  schema: S.ProviderVoiceListing,
  key: (input: ProviderVoiceRequest) => ["provider-voices", input.connection, input.revision, input.after ?? null],
  fetch: (input, context) => api.provider.voice.list(input, context),
});

export function SpeechPanel() {
  const core = useCore();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const scope = () => `${status()?.revision}:${status()?.speech?.connection}`;
  const [page, setPage] = createSignal<{ scope: string; after: string }>();
  const [selected, setSelected] = createSignal<{ scope: string; id: string; name: string }>();
  const voice = () => (selected()?.scope === scope() ? selected() : undefined);
  const voices = useQuery(
    () => {
      const after = page()?.scope === scope() ? page()?.after : undefined;
      return voicesQuery({
        connection: status()?.speech?.connection ?? "",
        revision: status()?.revision ?? 0,
        limit: 20,
        ...(after ? { after } : {}),
      });
    },
    { enabled: () => status()?.speech !== null && status()?.speech !== undefined },
  );
  const options = () => {
    const list = (ready(voices, undefined)?.voices ?? []).map((item) => ({ value: item.id, label: item.name ? `${item.name} · ${item.id}` : item.id }));
    const chosen = voice();
    return chosen && !list.some((item) => item.value === chosen.id) ? [{ value: chosen.id, label: chosen.name }, ...list] : list;
  };
  const [text, setText] = createSignal("");
  const [format, setFormat] = createSignal<MediaAudioFormat>("wav");
  const [execution, setExecution] = createSignal<"synchronous" | "asynchronous" | "streaming">("synchronous");
  const [streamActive, setStreamActive] = createSignal(false);
  const flashSupported = () => status()?.speech?.model.startsWith("moss-tts-1.5-flash") === true;
  const [submitted, setSubmitted] = createSignal<{ request: MediaSpeechRequest; model: string; name: string }>();
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const jobs = () => core()?.media?.filter((job) => job.kind === "speech") ?? [];
  const prepare = () => {
    const previous = submitted();
    if (previous) return previous.request;
    const configuration = status();
    const binding = configuration?.speech;
    const chosen = voice();
    if (!configuration || !binding || !chosen || !text().trim() || (execution() === "streaming" && !flashSupported())) return;
    const request: MediaSpeechRequest = {
      id: crypto.randomUUID(),
      text: text(),
      voice: chosen.id,
      format: execution() === "streaming" ? "pcm" : format(),
      asynchronous: execution() === "asynchronous",
      streaming: execution() === "streaming",
      connection: binding.connection,
      revision: configuration.revision,
    };
    setSubmitted({
      request,
      model: binding.model,
      name: configuration.connections.find((item) => item.id === binding.connection)?.name ?? binding.connection,
    });
    return request;
  };
  const submit = () => {
    if (act.busy() || streamActive()) return;
    const request = prepare();
    if (!request || request.streaming === true) return;
    return act.run(() => api.media.speech.create(request));
  };
  return (
    <section {...stylex.attrs(viewStyles.section)} data-testid="speech-panel" aria-label={t("web.media.speech.title")}>
      <Card title={t("web.media.speech.title")}>
        <p {...stylex.attrs(viewStyles.notice)}>{t("web.media.speech.notice")}</p>
        <Show when={status()?.speech} fallback={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.media.speech.configure")}</Quiet>}>
          <p
            {...stylex.attrs(viewStyles.identifierDetail)}
            data-testid="speech-connection"
            data-connection={status()?.speech?.connection}
            data-revision={status()?.revision}
            data-model={status()?.speech?.model}
          >
            {t("web.media.speech.binding", {
              account: status()?.connections.find((item) => item.id === status()?.speech?.connection)?.name ?? "",
              connection: status()?.speech?.connection ?? "",
              model: status()?.speech?.model ?? "",
              revision: status()?.revision ?? 0,
            })}
          </p>
        </Show>
        <Button data-testid="speech-refresh" disabled={act.busy() || query.fetching()} onClick={() => void act.run(() => query.refetch())}>
          {t("web.media.speech.refresh")}
        </Button>
        <fieldset
          disabled={act.busy() || streamActive() || submitted() !== undefined}
          {...stylex.attrs(viewStyles.form)}
          aria-label={t("web.media.speech.title")}
        >
          <Field label={t("web.media.speech.voice")} hint={t("web.media.speech.voiceHint")}>
            <Select
              label={t("web.media.speech.voice")}
              testid="speech-voice"
              placeholder={t("web.media.speech.chooseVoice")}
              disabled={act.busy() || streamActive() || submitted() !== undefined || voices.fetching() || !status()?.speech}
              value={voice()?.id ?? ""}
              options={options()}
              onChange={(id) => setSelected({ scope: scope(), id, name: options().find((item) => item.value === id)?.label ?? id })}
            />
          </Field>
          <Show when={status()?.speech}>
            <div {...stylex.attrs(viewStyles.actions)}>
              <Button
                data-testid="speech-voices-first"
                disabled={voices.fetching()}
                onClick={() => {
                  setPage(undefined);
                  if (page()?.scope !== scope() || !page()?.after) void act.run(() => voices.refetch());
                }}
              >
                {t("web.media.speech.firstVoices")}
              </Button>
              <Button
                data-testid="speech-voices-next"
                disabled={voices.fetching() || ready(voices, undefined)?.hasMore !== true}
                onClick={() => {
                  const after = ready(voices, undefined)?.nextCursor;
                  if (after) setPage({ scope: scope(), after });
                }}
              >
                {t("web.media.speech.nextVoices")}
              </Button>
            </div>
            <Show when={voices.fetching()}>
              <Quiet>{t("web.base.form.asking")}</Quiet>
            </Show>
            <Show when={voices.status() === "success" && ready(voices, undefined)?.voices.length === 0}>
              <Quiet>{t("web.media.speech.emptyVoices")}</Quiet>
            </Show>
            <Show when={voices.error()}>
              {(why) => (
                <p role="alert" {...stylex.attrs(viewStyles.error)}>
                  {reasonOf(why())}
                </p>
              )}
            </Show>
          </Show>
          <Field label={t("web.media.speech.format")}>
            <Select
              label={t("web.media.speech.format")}
              testid="speech-format"
              disabled={act.busy() || streamActive() || submitted() !== undefined || execution() === "streaming"}
              value={execution() === "streaming" ? "pcm" : format()}
              onChange={setFormat}
              options={MediaAudioFormatValues.map((value) => ({ value, label: value.toUpperCase() }))}
            />
          </Field>
          <Field label={t("web.media.speech.execution")}>
            <Select
              label={t("web.media.speech.execution")}
              testid="speech-execution"
              disabled={act.busy() || streamActive() || submitted() !== undefined}
              value={execution()}
              onChange={setExecution}
              options={[
                { value: "synchronous", label: t("web.media.speech.synchronous") },
                { value: "asynchronous", label: t("web.media.speech.asynchronous") },
                ...(flashSupported() || execution() === "streaming" ? [{ value: "streaming" as const, label: t("web.audio.flashTitle") }] : []),
              ]}
            />
          </Field>
          <Field label={t("web.media.speech.text")}>
            <TextArea
              data-testid="speech-text"
              aria-label={t("web.media.speech.text")}
              rows={5}
              maxlength={10000}
              value={text()}
              onInput={(event) => setText(event.currentTarget.value)}
            />
          </Field>
        </fieldset>
        <Show when={execution() === "streaming"}>
          <FlashPlayer
            request={submitted()?.request}
            valid={flashSupported() && Boolean(voice()) && Boolean(text().trim())}
            prepare={prepare}
            onActive={setStreamActive}
          />
        </Show>
        <Show when={submitted()}>
          {(sent) => (
            <div
              data-testid="speech-request"
              data-id={sent().request.id}
              data-connection={sent().request.connection}
              data-revision={sent().request.revision}
              {...stylex.attrs(viewStyles.stack)}
            >
              <p {...stylex.attrs(viewStyles.detail)}>{t("web.media.speech.pending")}</p>
              <p {...stylex.attrs(viewStyles.identifierDetail)}>
                {t("web.media.speech.binding", {
                  account: sent().name,
                  connection: sent().request.connection,
                  model: sent().model,
                  revision: sent().request.revision,
                })}
                {" · "}
                {sent().request.voice}
                {" · "}
                {sent().request.format}
                {" · "}
                {sent().request.id}
              </p>
            </div>
          )}
        </Show>
        <div {...stylex.attrs(viewStyles.actions)}>
          <Show when={execution() !== "streaming"}>
            <Button
              data-testid="speech-generate"
              tone="primary"
              disabled={act.busy() || (!submitted() && (!status()?.speech || !voice() || !text().trim()))}
              onClick={() => void submit()}
            >
              {submitted() ? t("web.media.resubmit") : t("web.media.speech.submit")}
            </Button>
          </Show>
          <Show when={submitted()}>
            <ConfirmButton
              testid="speech-new"
              label={t("web.media.speech.new")}
              question={t("web.media.newAsk")}
              disabled={act.busy() || streamActive()}
              onConfirm={() => {
                setSubmitted(undefined);
                setError(undefined);
              }}
            />
          </Show>
        </div>
        <Show when={error()}>
          {(why) => (
            <p role="alert" data-testid="speech-error" {...stylex.attrs(viewStyles.error)}>
              {why()}
            </p>
          )}
        </Show>
      </Card>
      <h2 {...stylex.attrs(viewStyles.heading)}>{t("web.media.speech.history")}</h2>
      <Show when={jobs().length > 0} fallback={<Quiet>{t("web.media.speech.empty")}</Quiet>}>
        <For each={jobs()} keyed={(job) => job.id}>
          {(job) => <SpeechJob job={job()} />}
        </For>
      </Show>
    </section>
  );
}

function SpeechAudio(props: { src: string; name: string; mime: string; format: MediaAudioFormat }) {
  let player: HTMLAudioElement | undefined;
  const [playable, setPlayable] = createSignal(false);
  onSettled(() => {
    setPlayable(props.format !== "pcm" && document.createElement("audio").canPlayType(props.mime) !== "");
    return () => {
      player?.pause();
      player?.removeAttribute("src");
      player?.load();
    };
  });
  return (
    <Show when={playable()} fallback={<Quiet>{t("web.media.speech.downloadOnly")}</Quiet>}>
      <audio
        ref={(element) => {
          player = element;
        }}
        data-testid="speech-audio"
        onError={() => setPlayable(false)}
        src={props.src}
        controls
        autoplay={false}
        preload="metadata"
        aria-label={props.name}
        {...stylex.attrs(viewStyles.player)}
      />
    </Show>
  );
}

function SpeechJob(props: { job: MediaSpeechJob }) {
  const core = useCore();
  const [channel, setChannel] = createSignal("");
  const [posted, setPosted] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const result = () => {
    const input = props.job.resultInput;
    if (input) return { src: mediaInputContentPath(input.id), name: input.name, mime: input.mime };
    const file = props.job.attachment;
    return file ? { src: attachmentPath(file.id), name: file.name, mime: file.type } : undefined;
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
      <div data-testid="speech-job" data-id={props.job.id} data-phase={props.job.phase} {...stylex.attrs(viewStyles.form)}>
        <p data-testid="speech-format-result" data-format={props.job.format} {...stylex.attrs(viewStyles.identifierDetail)}>
          {props.job.model} · {props.job.connection} · {props.job.revision} · {props.job.voice} · {props.job.format} · {props.job.id}
        </p>
        <p data-testid="speech-source" {...stylex.attrs(viewStyles.source)}>
          {props.job.source.kind === "user"
            ? t("web.media.sourceUser")
            : t("web.media.sourceAgent", { agent: props.job.source.agent, channel: props.job.source.channel })}
        </p>
        <Show when={props.job.metadata}>
          {(metadata) => (
            <div data-testid="speech-metadata" data-source={metadata().source} {...stylex.attrs(viewStyles.metadata)}>
              <span>{metadata().source === "file" ? t("web.audio.metadataFile") : t("web.audio.metadataProvider")}</span>
              <Show when={metadata().sampleRate !== undefined}>
                <span>{t("web.audio.metadataRate", { value: metadata().sampleRate ?? "" })}</span>
              </Show>
              <Show when={metadata().duration !== undefined}>
                <span>{t("web.audio.metadataDuration", { value: metadata().duration?.toFixed(3) ?? "" })}</span>
              </Show>
              <Show when={metadata().channels !== undefined}>
                <span>{t("web.audio.metadataChannels", { value: metadata().channels ?? "" })}</span>
              </Show>
              <Show when={metadata().bitDepth !== undefined}>
                <span>{t("web.audio.metadataBits", { value: metadata().bitDepth ?? "" })}</span>
              </Show>
            </div>
          )}
        </Show>
        <Show when={props.job.usage}>
          {(usage) => (
            <div data-testid="speech-usage" {...stylex.attrs(viewStyles.metadata)}>
              <Show when={usage().inputCharacters !== undefined}>
                <span>{t("web.audio.usageCharacters", { value: usage().inputCharacters ?? "" })}</span>
              </Show>
              <Show when={usage().promptTokens !== undefined}>
                <span>{t("web.audio.usagePrompt", { value: usage().promptTokens ?? "" })}</span>
              </Show>
              <Show when={usage().completionTokens !== undefined}>
                <span>{t("web.audio.usageCompletion", { value: usage().completionTokens ?? "" })}</span>
              </Show>
              <Show when={usage().totalTokens !== undefined}>
                <span>{t("web.audio.usageTotal", { value: usage().totalTokens ?? "" })}</span>
              </Show>
            </div>
          )}
        </Show>
        <Show when={props.job.canRelease}>
          <ReleaseAssets id={props.job.id} />
        </Show>
        <Show when={props.job.canResume}>
          <Button
            data-testid="speech-resume"
            disabled={act.busy()}
            onClick={() => {
              const id = props.job.id;
              void act.run(() => api.media.speech.resume({ id }));
            }}
          >
            {t("web.media.speech.resume")}
          </Button>
        </Show>
        <p {...stylex.attrs(viewStyles.prose)}>{props.job.prompt}</p>
        <Show when={props.job.problem}>
          <p data-testid="speech-problem" {...stylex.attrs(viewStyles.notice)}>
            {props.job.problem}
          </p>
        </Show>
        <Show when={result()}>
          {(file) => (
            <>
              <SpeechAudio src={file().src} name={file().name} mime={props.job.contentType ?? file().mime} format={props.job.format} />
              <a data-testid="speech-save" href={file().src} download={file().name} {...stylex.attrs(viewStyles.link)}>
                {t("web.media.speech.save")}
              </a>
            </>
          )}
        </Show>
        <Show when={props.job.attachment}>
          {(file) => (
            <>
              <Field label={t("web.media.channel")}>
                <Select
                  label={t("web.media.channel")}
                  testid="speech-channel"
                  disabled={act.busy()}
                  placeholder={t("web.media.chooseChannel")}
                  value={channel()}
                  onChange={(value) => {
                    setChannel(value);
                    setPosted(false);
                  }}
                  options={(core()?.chat?.channels ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
                />
              </Field>
              <Button
                data-testid="speech-publish"
                data-published={posted() ? "true" : "false"}
                disabled={act.busy() || !channel() || posted()}
                onClick={() => void publish(file().id)}
              >
                {posted() ? t("web.media.published") : t("web.media.speech.publish")}
              </Button>
            </>
          )}
        </Show>
        <div {...stylex.attrs(viewStyles.actions)}>
          <Show when={props.job.canCancel}>
            <ConfirmButton
              testid="speech-cancel"
              label={t("web.media.cancel")}
              question={t("web.media.cancelAsk")}
              disabled={act.busy()}
              onConfirm={() => {
                const id = props.job.id;
                void act.run(() => api.media.job.cancel({ id }));
              }}
            />
          </Show>
          <Show when={props.job.canRetryDownload}>
            <Button
              data-testid="speech-retry-download"
              disabled={act.busy()}
              onClick={() => {
                const id = props.job.id;
                void act.run(() => api.media.job.download({ id }));
              }}
            >
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
