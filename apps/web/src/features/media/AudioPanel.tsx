import { createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import {
  attachmentPath,
  mediaInputContentPath,
  type ArtifactId,
  type MediaAudioAccountRequest,
  type MediaAudioFormat,
  type MediaAudioJob,
  type MediaCloneRequest,
  type MediaInput,
  type MediaSpeakersRequest,
  type MediaTranscriptionRequest,
  type MediaVoiceDesignRequest,
  type Preview,
  type ProviderStatus,
  type ProviderVoiceRequest,
} from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { api, reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { uploadMediaInput } from "#/infra/media.ts";
import { defineQuery, providerQuery, ready, useQuery } from "#/infra/query.ts";
import { Link } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { Field, Select, TextArea, TextInput } from "#/ui/Field.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";

import { audioTimestamp, dialogueComplete, supportsStreamingTranscription, transcriptContent } from "./audio.ts";
import { ReleaseAssets } from "./ReleaseAssets.tsx";

const voicesQuery = defineQuery({
  schema: S.ProviderVoiceListing,
  key: (input: ProviderVoiceRequest) => ["provider-voices", input.connection, input.revision, input.after ?? null],
  fetch: (input, context) => api.provider.voice.list(input, context),
});

type AudioMode = "speakers" | "voiceDesign" | "clone" | "transcription";
const modes: AudioMode[] = ["speakers", "voiceDesign", "clone", "transcription"];
const title = (kind: AudioMode) => {
  switch (kind) {
    case "speakers":
      return t("web.audio.speakerTitle");
    case "voiceDesign":
      return t("web.audio.designTitle");
    case "clone":
      return t("web.audio.cloneTitle");
    case "transcription":
      return t("web.audio.transcriptionTitle");
  }
};

export function AudioPanel() {
  const core = useCore();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const [mode, setMode] = createSignal<AudioMode>("speakers");
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const jobs = () =>
    core()?.media?.filter(
      (job): job is MediaAudioJob => job.kind === "speakers" || job.kind === "voiceDesign" || job.kind === "clone" || job.kind === "transcription",
    ) ?? [];
  return (
    <section class="flex min-w-0 flex-col gap-4" data-testid="audio-panel" aria-label={t("web.audio.title")}>
      <p class="text-sm text-muted">{t("web.audio.notice")}</p>
      <Button data-testid="audio-refresh" disabled={act.busy() || query.fetching()} onClick={() => void act.run(() => query.refetch())}>
        {t("web.audio.refresh")}
      </Button>
      <AudioError error={error() ?? (query.error() ? reasonOf(query.error()) : undefined)} />
      <div class="flex flex-wrap gap-2">
        <For each={modes}>
          {(kind) => (
            <Button
              data-testid={`audio-mode-${kind}`}
              aria-pressed={mode() === kind ? "true" : "false"}
              tone={mode() === kind ? "primary" : "plain"}
              onClick={() => setMode(kind)}
            >
              {title(kind)}
            </Button>
          )}
        </For>
      </div>
      <Show when={mode() === "speakers"}>
        <SpeakersForm status={status()} />
      </Show>
      <Show when={mode() === "voiceDesign"}>
        <DesignForm status={status()} />
      </Show>
      <Show when={mode() === "clone"}>
        <UploadForm kind="clone" status={status()} />
      </Show>
      <Show when={mode() === "transcription"}>
        <UploadForm kind="transcription" status={status()} />
      </Show>
      <h2 class="text-base font-semibold">{t("web.audio.history")}</h2>
      <Show when={jobs().length > 0} fallback={<Quiet>{t("web.audio.empty")}</Quiet>}>
        <For each={jobs()} keyed={(job) => job.id}>
          {(job) => <AudioJob job={job()} />}
        </For>
      </Show>
    </section>
  );
}

function AudioError(props: { error: string | undefined }) {
  return (
    <Show when={props.error}>
      {(error) => (
        <p role="alert" data-testid="audio-error" class="text-sm wrap-break-word text-berry">
          {error()}
        </p>
      )}
    </Show>
  );
}

function Binding(props: { connection: string | undefined; revision: number | undefined; model: string | undefined }) {
  return (
    <Show when={props.connection} fallback={<Quiet>{t("web.audio.configure")}</Quiet>}>
      <p
        data-testid="audio-binding"
        data-connection={props.connection}
        data-revision={props.revision}
        data-model={props.model}
        class="text-xs break-all text-muted"
      >
        {props.connection} · {props.model} · {props.revision}
      </p>
    </Show>
  );
}

function VoicePicker(props: { connection: string; revision: number; value: string; disabled: boolean; testid: string; onChange: (voice: string) => void }) {
  const scope = () => `${props.connection}:${props.revision}`;
  const [page, setPage] = createSignal<{ scope: string; after: string }>();
  const [search, setSearch] = createSignal("");
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const voices = useQuery(
    () => {
      const after = page()?.scope === scope() ? page()?.after : undefined;
      return voicesQuery({ connection: props.connection, revision: props.revision, limit: 20, ...(after ? { after } : {}) });
    },
    { enabled: () => Boolean(props.connection) },
  );
  const options = () => {
    const term = search().trim().toLowerCase();
    const items = (ready(voices, undefined)?.voices ?? [])
      .filter((voice) => !term || voice.id.toLowerCase().includes(term) || voice.name.toLowerCase().includes(term))
      .map((voice) => ({ value: voice.id, label: voice.name ? `${voice.name} · ${voice.id}` : voice.id }));
    return props.value && !items.some((item) => item.value === props.value) ? [{ value: props.value, label: props.value }, ...items] : items;
  };
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <Field label={t("web.audio.queryVoice")} hint={t("web.audio.queryHint")}>
        <TextInput
          data-testid={`${props.testid}-search`}
          aria-label={t("web.audio.queryVoice")}
          disabled={props.disabled}
          value={search()}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
      </Field>
      <Field label={t("web.audio.voice")}>
        <Select
          testid={props.testid}
          label={t("web.audio.voice")}
          placeholder={t("web.audio.chooseVoice")}
          disabled={props.disabled || voices.fetching() || !props.connection}
          value={props.value}
          options={options()}
          onChange={(voice) => props.onChange(voice)}
        />
      </Field>
      <div class="flex flex-wrap gap-2">
        <Button
          data-testid={`${props.testid}-first`}
          disabled={props.disabled || voices.fetching() || !props.connection}
          onClick={() => {
            const first = page()?.scope !== scope() || !page()?.after;
            setPage(undefined);
            if (first) void act.run(() => voices.refetch());
          }}
        >
          {t("web.audio.first")}
        </Button>
        <Button
          data-testid={`${props.testid}-next`}
          disabled={props.disabled || voices.fetching() || ready(voices, undefined)?.hasMore !== true}
          onClick={() => {
            const after = ready(voices, undefined)?.nextCursor;
            if (after) setPage({ scope: scope(), after });
          }}
        >
          {t("web.audio.next")}
        </Button>
      </div>
      <Show when={voices.fetching()}>
        <Quiet>{t("web.base.form.asking")}</Quiet>
      </Show>
      <Show when={voices.status() === "success" && ready(voices, undefined)?.voices.length === 0}>
        <Quiet>{t("web.audio.emptyVoices")}</Quiet>
      </Show>
      <AudioError error={error() ?? (voices.error() ? reasonOf(voices.error()) : undefined)} />
    </div>
  );
}

function RequestActions(props: {
  request: MediaAudioAccountRequest | undefined;
  busy: boolean;
  valid: boolean;
  label: string;
  submit: () => void;
  reset: () => void;
}) {
  return (
    <>
      <Show when={props.request}>
        {(request) => (
          <div
            data-testid="audio-request"
            data-id={request().id}
            data-connection={request().connection}
            data-revision={request().revision}
            class="flex min-w-0 flex-col gap-1"
          >
            <p class="text-xs text-muted">{t("web.audio.pending")}</p>
            <p class="text-xs break-all text-muted">
              {request().id} · {request().connection} · {request().revision}
            </p>
          </div>
        )}
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button data-testid="audio-submit" tone="primary" disabled={props.busy || (!props.request && !props.valid)} onClick={() => props.submit()}>
          {props.request ? t("web.audio.check") : props.label}
        </Button>
        <Show when={props.request}>
          <ConfirmButton testid="audio-new" label={t("web.audio.new")} question={t("web.audio.newAsk")} disabled={props.busy} onConfirm={() => props.reset()} />
        </Show>
      </div>
    </>
  );
}

function AudioFormat(props: { value: MediaAudioFormat; disabled: boolean; design?: boolean; onChange: (value: MediaAudioFormat) => void }) {
  const formats = (): MediaAudioFormat[] => (props.design === true ? ["wav", "mp3", "flac"] : ["wav", "mp3", "flac", "aac", "opus", "pcm"]);
  return (
    <Field label={t("web.audio.format")}>
      <Select
        testid="audio-format"
        label={t("web.audio.format")}
        disabled={props.disabled}
        value={props.value}
        onChange={(value) => props.onChange(value)}
        options={formats().map((value) => ({ value, label: value.toUpperCase() }))}
      />
    </Field>
  );
}

function SpeakersForm(props: { status: ProviderStatus | undefined }) {
  const binding = () => props.status?.speakers;
  const scope = () => `${binding()?.connection}:${props.status?.revision}`;
  const [speakers, setSpeakers] = createSignal([{ key: "speaker-1", id: "", voice: "", scope: "" }]);
  const [segments, setSegments] = createSignal([{ key: "turn-1", speaker: "speaker-1", text: "" }]);
  const [format, setFormat] = createSignal<MediaAudioFormat>("wav");
  const [submitted, setSubmitted] = createSignal<MediaSpeakersRequest>();
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const mapped = () => speakers().map((speaker) => ({ id: speaker.id.trim(), voice: speaker.scope === scope() ? speaker.voice : "" }));
  const turns = () =>
    segments().map((segment) => ({
      speaker:
        speakers()
          .find((speaker) => speaker.key === segment.speaker)
          ?.id.trim() ?? "",
      text: segment.text,
    }));
  const valid = () => Boolean(binding()) && dialogueComplete(mapped(), turns());
  const disabled = () => act.busy() || Boolean(submitted());
  const submit = () => {
    if (act.busy()) return;
    const previous = submitted();
    if (previous) return act.run(() => api.media.dialogue.create(previous));
    const account = binding();
    const configuration = props.status;
    if (!account || !configuration || !valid()) return;
    const request: MediaSpeakersRequest = {
      id: crypto.randomUUID(),
      connection: account.connection,
      revision: configuration.revision,
      speakers: mapped(),
      segments: turns(),
      format: format(),
    };
    setSubmitted(request);
    return act.run(() => api.media.dialogue.create(request));
  };
  return (
    <Card title={t("web.audio.speakerTitle")}>
      <p class="text-sm text-muted">{t("web.audio.speakerHint")}</p>
      <Binding connection={binding()?.connection} model={binding()?.model} revision={props.status?.revision} />
      <fieldset disabled={disabled()} class="flex min-w-0 flex-col gap-4" aria-label={t("web.audio.speakerTitle")}>
        <For each={speakers()} keyed={(speaker) => speaker.key}>
          {(speaker) => (
            <div class="flex min-w-0 flex-col gap-2" data-testid="audio-speaker">
              <Field label={t("web.audio.speaker")}>
                <TextInput
                  data-testid="audio-speaker-name"
                  aria-label={t("web.audio.speaker")}
                  maxlength={256}
                  pattern="[a-zA-Z0-9_-]+"
                  value={speaker().id}
                  onInput={(event) => {
                    const key = speaker().key;
                    const id = event.currentTarget.value;
                    setSpeakers((items) => items.map((item) => (item.key === key ? { ...item, id } : item)));
                  }}
                />
              </Field>
              <VoicePicker
                connection={binding()?.connection ?? ""}
                revision={props.status?.revision ?? 0}
                value={speaker().scope === scope() ? speaker().voice : ""}
                disabled={disabled()}
                testid="audio-speaker-voice"
                onChange={(voice) => {
                  const key = speaker().key;
                  const current = scope();
                  setSpeakers((items) => items.map((item) => (item.key === key ? { ...item, voice, scope: current } : item)));
                }}
              />
              <Button
                data-testid="audio-remove-speaker"
                disabled={disabled() || speakers().length <= 1}
                onClick={() => {
                  const key = speaker().key;
                  setSpeakers((items) => items.filter((item) => item.key !== key));
                }}
              >
                {t("web.audio.remove")}
              </Button>
            </div>
          )}
        </For>
        <Button
          data-testid="audio-add-speaker"
          disabled={disabled() || speakers().length >= 5}
          onClick={() => setSpeakers((items) => [...items, { key: crypto.randomUUID(), id: "", voice: "", scope: "" }])}
        >
          {t("web.audio.addSpeaker")}
        </Button>
        <h3 class="text-sm font-semibold">{t("web.audio.dialogue")}</h3>
        <For each={segments()} keyed={(segment) => segment.key}>
          {(segment) => (
            <div class="flex min-w-0 flex-col gap-2" data-testid="audio-turn">
              <Select
                testid="audio-turn-speaker"
                label={t("web.audio.speaker")}
                disabled={disabled()}
                value={segment().speaker}
                options={speakers().map((speaker) => ({ value: speaker.key, label: speaker.id || t("web.audio.speaker") }))}
                onChange={(speaker) => {
                  const key = segment().key;
                  setSegments((items) => items.map((item) => (item.key === key ? { ...item, speaker } : item)));
                }}
              />
              <Field label={t("web.audio.text")}>
                <TextArea
                  data-testid="audio-turn-text"
                  aria-label={t("web.audio.text")}
                  rows={3}
                  maxlength={10000}
                  value={segment().text}
                  onInput={(event) => {
                    const key = segment().key;
                    const text = event.currentTarget.value;
                    setSegments((items) => items.map((item) => (item.key === key ? { ...item, text } : item)));
                  }}
                />
              </Field>
              <Button
                disabled={disabled() || segments().length <= 1}
                onClick={() => {
                  const key = segment().key;
                  setSegments((items) => items.filter((item) => item.key !== key));
                }}
              >
                {t("web.audio.remove")}
              </Button>
            </div>
          )}
        </For>
        <Button
          data-testid="audio-add-turn"
          disabled={disabled()}
          onClick={() => {
            const speaker = speakers()[0]?.key ?? "";
            setSegments((items) => [...items, { key: crypto.randomUUID(), speaker, text: "" }]);
          }}
        >
          {t("web.audio.addTurn")}
        </Button>
        <AudioFormat value={format()} disabled={disabled()} onChange={setFormat} />
      </fieldset>
      <RequestActions
        request={submitted()}
        busy={act.busy()}
        valid={valid()}
        label={t("web.audio.generate")}
        submit={() => void submit()}
        reset={() => {
          setSubmitted(undefined);
          setError(undefined);
        }}
      />
      <AudioError error={error()} />
    </Card>
  );
}

function DesignForm(props: { status: ProviderStatus | undefined }) {
  const [text, setText] = createSignal("");
  const [instruction, setInstruction] = createSignal("");
  const [format, setFormat] = createSignal<MediaAudioFormat>("wav");
  const [submitted, setSubmitted] = createSignal<MediaVoiceDesignRequest>();
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const disabled = () => act.busy() || Boolean(submitted());
  const submit = () => {
    if (act.busy()) return;
    const previous = submitted();
    if (previous) return act.run(() => api.media.voiceDesign.create(previous));
    const configuration = props.status;
    if (!configuration?.voiceDesign || !text().trim() || !instruction().trim()) return;
    const request: MediaVoiceDesignRequest = {
      id: crypto.randomUUID(),
      connection: configuration.voiceDesign.connection,
      revision: configuration.revision,
      text: text(),
      instruction: instruction(),
      format: format(),
    };
    setSubmitted(request);
    return act.run(() => api.media.voiceDesign.create(request));
  };
  return (
    <Card title={t("web.audio.designTitle")}>
      <p class="text-sm text-muted">{t("web.audio.designHint")}</p>
      <Binding connection={props.status?.voiceDesign?.connection} model={props.status?.voiceDesign?.model} revision={props.status?.revision} />
      <fieldset disabled={disabled()} class="flex min-w-0 flex-col gap-3" aria-label={t("web.audio.designTitle")}>
        <Field label={t("web.audio.instructions")}>
          <TextArea
            data-testid="audio-instructions"
            aria-label={t("web.audio.instructions")}
            rows={3}
            maxlength={10000}
            value={instruction()}
            onInput={(event) => setInstruction(event.currentTarget.value)}
          />
        </Field>
        <Field label={t("web.audio.previewText")}>
          <TextArea
            data-testid="audio-preview-text"
            aria-label={t("web.audio.previewText")}
            rows={3}
            maxlength={10000}
            value={text()}
            onInput={(event) => setText(event.currentTarget.value)}
          />
        </Field>
        <AudioFormat value={format()} design disabled={disabled()} onChange={setFormat} />
      </fieldset>
      <RequestActions
        request={submitted()}
        busy={act.busy()}
        valid={Boolean(props.status?.voiceDesign && text().trim() && instruction().trim())}
        label={t("web.audio.preview")}
        submit={() => void submit()}
        reset={() => {
          setSubmitted(undefined);
          setError(undefined);
        }}
      />
      <AudioError error={error()} />
    </Card>
  );
}

function UploadForm(props: { kind: "clone" | "transcription"; status: ProviderStatus | undefined }) {
  const [account, setAccount] = createSignal("");
  const connection = () => (props.kind === "transcription" ? (props.status?.transcription?.connection ?? "") : account());
  const [selected, setSelected] = createSignal<{ file: File; input?: MediaInput }>();
  const [consent, setConsent] = createSignal<{ connection: string; revision: number; file: File }>();
  const approved = () => {
    const approval = consent();
    return Boolean(approval && approval.file === selected()?.file && approval.connection === connection() && approval.revision === props.status?.revision);
  };
  const [name, setName] = createSignal("");
  const [selectedVoice, setSelectedVoice] = createSignal<{ connection: string; revision: number; id: string }>();
  const [diarize, setDiarize] = createSignal(true);
  const [streaming, setStreaming] = createSignal(false);
  const supportsStreaming = () => supportsStreamingTranscription(props.status?.transcription?.model);
  const [submitted, setSubmitted] = createSignal<({ kind: "clone" } & MediaCloneRequest) | ({ kind: "transcription" } & MediaTranscriptionRequest)>();
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  let transfer: AbortController | undefined;
  onSettled(() => () => transfer?.abort());
  const disabled = () => act.busy() || Boolean(submitted());
  const submit = () => {
    if (act.busy()) return;
    const previous = submitted();
    const configuration = props.status;
    const chosen = selected();
    const chosenConnection = connection();
    const allowed = approved();
    const kind = props.kind;
    const voiceName = name().trim();
    const speakers = diarize();
    const stream = streaming() && supportsStreaming();
    const controller = new AbortController();
    transfer = controller;
    setError(undefined);
    return act
      .run(async () => {
        if (previous)
          return previous.kind === "clone"
            ? api.media.clone.create(previous, { signal: controller.signal })
            : api.media.transcription.create(previous, { signal: controller.signal });
        if (!configuration || !chosen || !chosenConnection || !allowed) return;
        const input =
          chosen.input ??
          (await api.media.input.create(
            { kind: "audio", name: chosen.file.name, mime: chosen.file.type, size: chosen.file.size },
            { signal: controller.signal },
          ));
        setSelected({ file: chosen.file, input });
        const uploaded = input.phase === "ready" ? input : await uploadMediaInput(input.id, chosen.file, controller.signal);
        setSelected({ file: chosen.file, input: uploaded });
        const base = { id: crypto.randomUUID(), input: uploaded.id, connection: chosenConnection, revision: configuration.revision };
        if (kind === "clone") {
          const request = { ...base, kind, consent: true, ...(voiceName ? { name: voiceName } : {}) } as const;
          setSubmitted(request);
          return api.media.clone.create(request, { signal: controller.signal });
        }
        const request = {
          ...base,
          kind,
          allowUpload: true,
          ...(supportsStreamingTranscription(configuration.transcription?.model) ? { diarize: speakers } : {}),
          ...(stream ? { streaming: true } : {}),
        } as const;
        setSubmitted(request);
        return api.media.transcription.create(request, { signal: controller.signal });
      })
      .finally(() => controller.abort());
  };
  return (
    <Card title={title(props.kind)}>
      <p class="text-sm text-muted">{props.kind === "clone" ? t("web.audio.cloneHint") : t("web.audio.transcriptionHint")}</p>
      <Show when={props.kind === "transcription"}>
        <Binding connection={connection()} model={props.status?.transcription?.model} revision={props.status?.revision} />
      </Show>
      <fieldset disabled={disabled()} class="flex min-w-0 flex-col gap-3" aria-label={title(props.kind)}>
        <Show when={props.kind === "clone"}>
          <Field label={t("web.audio.account")}>
            <Select
              testid="audio-account"
              label={t("web.audio.account")}
              placeholder={t("web.audio.chooseAccount")}
              value={account()}
              disabled={disabled()}
              options={(props.status?.connections ?? []).filter((item) => item.enabled).map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => {
                setAccount(value);
                setConsent(undefined);
              }}
            />
          </Field>
          <Field label={t("web.audio.voiceName")}>
            <TextInput
              data-testid="audio-voice-name"
              aria-label={t("web.audio.voiceName")}
              maxlength={1000}
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </Field>
        </Show>
        <Field label={t("web.audio.input")}>
          <TextInput
            type="file"
            data-testid="audio-file"
            aria-label={t("web.audio.input")}
            accept={props.kind === "clone" ? "audio/wav,audio/x-wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/flac,audio/x-flac" : "audio/*"}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              setSelected(file ? { file } : undefined);
              setConsent(undefined);
            }}
          />
        </Field>
        <Show when={selected()}>
          {(file) => (
            <p class="text-xs break-all text-muted">
              {file().file.name} · {file().file.size}
            </p>
          )}
        </Show>
        <Show when={props.kind === "transcription"}>
          <label class="flex items-start gap-2 text-sm">
            <Checkbox
              testid="audio-diarize"
              label={t("web.audio.diarize")}
              disabled={!supportsStreaming()}
              checked={supportsStreaming() && diarize()}
              onChange={setDiarize}
            />
            {t("web.audio.diarize")}
          </label>
        </Show>
        <Show when={props.kind === "transcription"}>
          <Field label={t("web.audio.execution")} hint={t("web.audio.executionHint")}>
            <Select
              testid="audio-execution"
              label={t("web.audio.execution")}
              disabled={disabled() || !supportsStreaming()}
              value={streaming() && supportsStreaming() ? "streaming" : "async"}
              options={[
                { value: "async", label: t("web.audio.executionAsync") },
                { value: "streaming", label: t("web.audio.executionStreaming") },
              ]}
              onChange={(value) => setStreaming(value === "streaming")}
            />
          </Field>
        </Show>
        <label class="flex items-start gap-2 text-sm">
          <Checkbox
            testid="audio-consent"
            label={t("web.audio.consent")}
            checked={approved()}
            disabled={!selected() || !connection()}
            onChange={(checked) => {
              const file = selected()?.file;
              const current = props.status;
              setConsent(checked && file && current && connection() ? { file, connection: connection(), revision: current.revision } : undefined);
            }}
          />
          {t("web.audio.consent")}
        </label>
      </fieldset>
      <Show when={act.busy() && !submitted()}>
        <p role="status" data-testid="audio-uploading" class="text-sm text-muted">
          {t("web.audio.uploading")}
        </p>
        <Button onClick={() => transfer?.abort()}>{t("web.audio.stopUpload")}</Button>
      </Show>
      <RequestActions
        request={submitted()}
        busy={act.busy()}
        valid={approved() && Boolean(connection())}
        label={props.kind === "clone" ? t("web.audio.clone") : t("web.audio.transcribe")}
        submit={() => void submit()}
        reset={() => {
          setSubmitted(undefined);
          setConsent(undefined);
          setError(undefined);
        }}
      />
      <AudioError error={error()} />
      <Show when={props.kind === "clone" && connection()}>
        <h3 class="text-sm font-semibold">{t("web.audio.voices")}</h3>
        <VoicePicker
          connection={connection()}
          revision={props.status?.revision ?? 0}
          value={selectedVoice()?.connection === connection() && selectedVoice()?.revision === props.status?.revision ? (selectedVoice()?.id ?? "") : ""}
          disabled={act.busy()}
          testid="audio-account-voice"
          onChange={(id) => setSelectedVoice({ connection: connection(), revision: props.status?.revision ?? 0, id })}
        />
      </Show>
    </Card>
  );
}

function AudioPlayer(props: { src: string; label: string; testid: string; mime?: string; player?: (element: HTMLAudioElement) => void }) {
  let player: HTMLAudioElement | undefined;
  const [playable, setPlayable] = createSignal(false);
  onSettled(() => {
    setPlayable(!props.mime || document.createElement("audio").canPlayType(props.mime) !== "");
    return () => {
      player?.pause();
      player?.removeAttribute("src");
      player?.load();
    };
  });
  return (
    <Show when={playable()} fallback={<p class="text-sm text-muted">{t("web.audio.playbackUnsupported")}</p>}>
      <audio
        ref={(element) => {
          player = element;
          props.player?.(element);
        }}
        data-testid={props.testid}
        src={props.src}
        controls
        autoplay={false}
        preload="metadata"
        aria-label={props.label}
        class="w-full max-w-full min-w-0"
        onError={() => setPlayable(false)}
      />
    </Show>
  );
}

function AudioJob(props: { job: MediaAudioJob }) {
  const core = useCore();
  const [error, setError] = createSignal<string>();
  const [name, setName] = createSignal("");
  const [saveRequest, setSaveRequest] = createSignal<MediaCloneRequest>();
  const originalSave = () => {
    const job = core()?.media?.find(
      (item) =>
        item.kind === "clone" &&
        item.request.input === props.job.previewInput &&
        item.connection === props.job.connection &&
        item.revision === props.job.revision,
    );
    return job?.kind === "clone" ? job.request : saveRequest();
  };
  const [saved, setSaved] = createSignal<ArtifactId>();
  const [cleanup, setCleanup] = createSignal<Preview>();
  const act = createAct(setError);
  let player: HTMLAudioElement | undefined;
  const transcription = () => (props.job.result?.kind === "transcription" ? props.job.result : undefined);
  const partial = () => props.job.phase !== "ready";
  const voice = () => (props.job.result?.kind === "clone" ? props.job.result.voice : undefined);
  const audio = () => {
    const input = props.job.resultInput;
    if (input) return { src: mediaInputContentPath(input.id), name: input.name, mime: input.mime };
    const file = props.job.attachment;
    return file ? { src: attachmentPath(file.id), name: file.name, mime: file.type } : undefined;
  };
  const content = () => {
    const result = transcription();
    const text = result ? transcriptContent(result.text, result.segments) : "";
    return text && partial() ? `${t("web.audio.partialTranscript")}\n\n${text}` : text;
  };
  const saveVoice = () => {
    if (act.busy() || !props.job.previewInput) return;
    const previous = originalSave();
    const job = props.job;
    const input = props.job.previewInput;
    const voiceName = name().trim();
    return act.run(async () => {
      if (previous) return api.media.clone.create(previous);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["audio-voice", job.id])));
      const id = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const request: MediaCloneRequest = {
        id,
        connection: job.connection,
        revision: job.revision,
        input,
        consent: true,
        ...(voiceName ? { name: voiceName } : {}),
      };
      setSaveRequest(request);
      return api.media.clone.create(request);
    });
  };
  return (
    <Card title={props.job.phaseText}>
      <div data-testid="audio-job" data-id={props.job.id} data-kind={props.job.kind} data-phase={props.job.phase} class="flex min-w-0 flex-col gap-3">
        <p class="text-xs font-medium">{title(props.job.kind)}</p>
        <p class="text-xs break-all text-muted">
          {props.job.model} · {props.job.connection} · {props.job.revision} · {props.job.id}
        </p>
        <Show when={props.job.format}>
          <p data-testid="audio-format-result" data-format={props.job.format} class="text-xs text-muted">
            {t("web.audio.format")}: {props.job.format?.toUpperCase()}
          </p>
        </Show>
        <Show when={props.job.metadata}>
          {(metadata) => (
            <div data-testid="audio-metadata" data-source={metadata().source} class="flex flex-wrap gap-2 text-xs text-muted">
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
        <p class="text-xs wrap-break-word text-muted">
          {props.job.source.kind === "user"
            ? t("web.media.sourceUser")
            : t("web.media.sourceAgent", { agent: props.job.source.agent, channel: props.job.source.channel })}
        </p>
        <p class="text-sm wrap-break-word whitespace-pre-wrap">{props.job.prompt}</p>
        <Show when={props.job.problem}>
          <p data-testid="audio-problem" class="text-sm wrap-break-word text-muted">
            {props.job.problem}
          </p>
        </Show>
        <Show when={audio()}>
          {(file) => (
            <>
              <Show when={props.job.format !== "pcm"} fallback={<p class="text-sm text-muted">{t("web.audio.playbackUnsupported")}</p>}>
                <AudioPlayer src={file().src} label={file().name} mime={props.job.contentType ?? file().mime} testid="audio-result-player" />
              </Show>
              <a data-testid="audio-download" href={file().src} download={file().name} class="text-sm text-water underline">
                {t("web.audio.downloadAudio")}
              </a>
            </>
          )}
        </Show>
        <Show when={props.job.kind === "voiceDesign" && props.job.previewInput}>
          <p class="text-sm text-muted">{t("web.audio.designHint")}</p>
          <Field label={t("web.audio.voiceName")}>
            <TextInput
              data-testid="audio-save-name"
              aria-label={t("web.audio.voiceName")}
              maxlength={1000}
              disabled={act.busy() || Boolean(originalSave())}
              value={originalSave()?.name ?? name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </Field>
          <Button data-testid="audio-save-voice" data-request={originalSave()?.id} disabled={act.busy()} onClick={() => void saveVoice()}>
            {originalSave() ? t("web.audio.check") : t("web.audio.saveVoice")}
          </Button>
        </Show>
        <Show when={voice()}>
          {(result) => (
            <p data-testid="audio-saved-voice" data-voice={result().id} class="text-sm break-all">
              {t("web.audio.savedVoice", { voice: result().name ? `${result().name} · ${result().id}` : result().id })}
            </p>
          )}
        </Show>
        <Show when={transcription()}>
          {(result) => (
            <>
              <h3 class="text-sm font-semibold">{t("web.audio.transcript")}</h3>
              <Show when={partial()}>
                <p role="status" data-testid="audio-partial" class="text-sm text-muted">
                  {t("web.audio.partialTranscript")}
                </p>
              </Show>
              <p data-testid="audio-transcript" class="text-sm wrap-break-word whitespace-pre-wrap">
                {result().text}
              </p>
              <Show when={props.job.input}>
                {(input) => (
                  <AudioPlayer
                    src={mediaInputContentPath(input().id)}
                    label={t("web.audio.localPlayback")}
                    testid="audio-input-player"
                    player={(element) => {
                      player = element;
                    }}
                  />
                )}
              </Show>
              <h3 class="text-sm font-semibold">{t("web.audio.timeline")}</h3>
              <Show when={result().segments.length > 0} fallback={<Quiet>{t("web.audio.noTimestamps")}</Quiet>}>
                <ol class="flex min-w-0 flex-col gap-3" data-testid="audio-timeline">
                  <For each={result().segments}>
                    {(segment) => (
                      <li class="flex min-w-0 flex-col gap-1">
                        <Button
                          data-testid="audio-seek"
                          data-start={segment.start}
                          disabled={!props.job.input}
                          aria-label={t("web.audio.seek", { time: audioTimestamp(segment.start) })}
                          onClick={() => {
                            if (player) player.currentTime = segment.start;
                          }}
                        >
                          {audioTimestamp(segment.start)} – {audioTimestamp(segment.end)}
                        </Button>
                        <span class="text-xs font-medium wrap-break-word">{segment.speaker || t("web.audio.unknownSpeaker")}</span>
                        <p class="text-sm wrap-break-word whitespace-pre-wrap">{segment.text}</p>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
              <a
                data-testid="audio-download-transcript"
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(content())}`}
                download={`${props.job.id}${partial() ? "-partial" : ""}.txt`}
                class="text-sm text-water underline"
              >
                {partial() ? t("web.audio.downloadPartialTranscript") : t("web.audio.downloadTranscript")}
              </a>
              <Button
                data-testid="audio-save-transcript"
                disabled={act.busy() || Boolean(saved()) || !content()}
                onClick={() => {
                  const text = content();
                  const name = props.job.input?.name ?? props.job.id;
                  const title = partial() ? `${name} — ${t("web.audio.partialTitle")}` : name;
                  void act.run(async () => setSaved((await api.artifact.create({ title, kind: "markdown", content: text })).id));
                }}
              >
                {partial() ? t("web.audio.savePartialTranscript") : t("web.audio.saveTranscript")}
              </Button>
              <Show when={saved()}>
                {(id) => (
                  <Link data-testid="audio-artifact" href={`/artifacts/${id()}`} class="text-sm text-water underline">
                    {t("web.audio.openTranscript")}
                  </Link>
                )}
              </Show>
            </>
          )}
        </Show>
        <Show when={props.job.usage}>
          {(usage) => (
            <div data-testid="audio-usage" class="flex flex-wrap gap-2 text-xs text-muted">
              <Show when={usage().inputAudioSeconds !== undefined}>
                <span>{t("web.audio.usageAudioSeconds", { value: usage().inputAudioSeconds ?? "" })}</span>
              </Show>
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
        <Show when={props.job.canCleanup}>
          <Button
            data-testid="audio-preview-cleanup"
            disabled={act.busy()}
            onClick={() => {
              const id = props.job.id;
              void act.run(async () => setCleanup(await api.media.audio.previewCleanup({ id })));
            }}
          >
            {t("web.audio.cleanupPreview")}
          </Button>
          <Show when={cleanup()}>
            {(preview) => (
              <div class="flex min-w-0 flex-col gap-2">
                <ul class="list-inside list-disc text-sm text-muted">
                  <For each={preview().does}>{(step) => <li class="wrap-break-word">{step}</li>}</For>
                </ul>
                <ConfirmButton
                  testid="audio-cleanup"
                  label={t("web.audio.cleanup")}
                  question={t("web.audio.cleanupAsk")}
                  disabled={act.busy()}
                  onConfirm={() => {
                    const id = props.job.id;
                    void act.run(async () => {
                      await api.media.audio.cleanup({ id });
                      setCleanup(undefined);
                    });
                  }}
                />
              </div>
            )}
          </Show>
        </Show>
        <div class="flex flex-wrap gap-2">
          <Show when={props.job.canCancel}>
            <ConfirmButton
              testid="audio-cancel"
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
              data-testid="audio-retry-download"
              disabled={act.busy()}
              onClick={() => {
                const id = props.job.id;
                void act.run(() => api.media.job.download({ id }));
              }}
            >
              {t("web.media.retry")}
            </Button>
          </Show>
          <Show when={props.job.canResume}>
            <Button
              data-testid="audio-resume"
              disabled={act.busy()}
              onClick={() => {
                const id = props.job.id;
                void act.run(() => api.media.audio.resume({ id }));
              }}
            >
              {t("web.audio.resume")}
            </Button>
          </Show>
        </div>
        <AudioError error={error()} />
      </div>
    </Card>
  );
}
