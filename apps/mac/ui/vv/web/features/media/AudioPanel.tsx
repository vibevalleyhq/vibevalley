import { cleanup, Clipboard, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import {
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
} from "@vibevalley/protocol";

import { useTimeout } from "../../base/timer";
import { api, reasonOf } from "../../infra/api";
import { type LocalFile, pickFile, playInput, uploadAudio } from "../../infra/attachmentFile";
import { useCore } from "../../infra/frame";
import { providerQuery, providerVoicesQuery, ready, useQuery } from "../../infra/query";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { sizeText } from "../../ui/domain/AttachmentTile";
import { Field, Select, TextArea, TextInput } from "../../ui/Field";
import { Card, Quiet } from "../../ui/layout";
import { TextLink } from "../../ui/TextLink";
import { audioTimestamp, dialogueComplete, supportsStreamingTranscription, transcriptContent } from "./audio";
import { AudioMetadataLine, AudioUsageLine, JobActions, Refusal, ResultAudio, SourceLine } from "./JobFacts";
import { ReleaseAssets } from "./ReleaseAssets";

type AudioMode = "speakers" | "voiceDesign" | "clone" | "transcription";
const modes: AudioMode[] = ["speakers", "voiceDesign", "clone", "transcription"];

const titleOf = (kind: AudioMode) => {
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

const speakerId = (typed: string) => typed.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 256);

export function AudioPanel() {
  const core = useCore();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const mode = signal<AudioMode>("speakers");
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const jobs = () =>
    core()?.media?.filter(
      (job): job is MediaAudioJob => job.kind === "speakers" || job.kind === "voiceDesign" || job.kind === "clone" || job.kind === "transcription",
    ) ?? [];

  return (
    <View testID="audio-panel" accessibilityLabel={t("web.audio.title")} class="min-w-0 gap-4">
      <Text class="text-sm text-muted">{t("web.audio.notice")}</Text>
      <View class="flex-row">
        <Button testID="audio-refresh" disabled={act.busy() || query.fetching()} onPress={() => void act.run(() => query.refetch())}>
          {t("web.audio.refresh")}
        </Button>
      </View>
      <Refusal error={error() ?? (query.error() ? reasonOf(query.error()) : undefined)} testid="audio-error" />
      <View class="flex-row flex-wrap gap-2">
        <Each of={modes}>
          {(kind) => (
            <Button testID={`audio-mode-${kind()}`} tone={mode() === kind() ? "primary" : "plain"} onPress={() => mode.set(kind())}>
              {titleOf(kind())}
            </Button>
          )}
        </Each>
      </View>
      <If when={mode() === "speakers"}>
        <SpeakersForm status={status()} />
      </If>
      <If when={mode() === "voiceDesign"}>
        <DesignForm status={status()} />
      </If>
      <If when={mode() === "clone"}>
        <UploadForm kind="clone" status={status()} />
      </If>
      <If when={mode() === "transcription"}>
        <UploadForm kind="transcription" status={status()} />
      </If>
      <Text class="text-base font-semibold text-ink">{t("web.audio.history")}</Text>
      <If when={jobs().length > 0} else={<Quiet>{t("web.audio.empty")}</Quiet>}>
        <Each of={jobs()} key={(job) => job.id}>
          {(job) => <AudioJobCard job={job()} />}
        </Each>
      </If>
    </View>
  );
}

function Binding(props: { connection: string | undefined; revision: number | undefined; model: string | undefined }) {
  return (
    <If when={props.connection} else={<Quiet>{t("web.audio.configure")}</Quiet>}>
      <Text testID="audio-binding" class="text-xs text-muted">
        {`${props.connection} · ${props.model} · ${props.revision}`}
      </Text>
    </If>
  );
}

function VoicePicker(props: { connection: string; revision: number; value: string; disabled: boolean; testid: string; onChange: (voice: string) => void }) {
  const scope = () => `${props.connection}:${props.revision}`;
  const page = signal<{ scope: string; after: string } | undefined>(undefined);
  const search = signal("");
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const voices = useQuery(
    () => {
      const after = page()?.scope === scope() ? page()?.after : undefined;
      return providerVoicesQuery({ connection: props.connection, revision: props.revision, limit: 20, ...(after ? { after } : {}) });
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
    <View class="min-w-0 gap-2">
      <Field label={t("web.audio.queryVoice")} hint={t("web.audio.queryHint")}>
        <TextInput
          testID={`${props.testid}-search`}
          accessibilityLabel={t("web.audio.queryVoice")}
          disabled={props.disabled}
          value={search()}
          onInput={(v) => search.set(v)}
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
      <View class="flex-row flex-wrap gap-2">
        <Button
          testID={`${props.testid}-first`}
          disabled={props.disabled || voices.fetching() || !props.connection}
          onPress={() => {
            const first = page()?.scope !== scope() || !page()?.after;
            page.set(undefined);
            if (first) void act.run(() => voices.refetch());
          }}
        >
          {t("web.audio.first")}
        </Button>
        <Button
          testID={`${props.testid}-next`}
          disabled={props.disabled || voices.fetching() || ready(voices, undefined)?.hasMore !== true}
          onPress={() => {
            const after = ready(voices, undefined)?.nextCursor;
            if (after) page.set({ scope: scope(), after });
          }}
        >
          {t("web.audio.next")}
        </Button>
      </View>
      <If when={voices.fetching()}>
        <Quiet>{t("web.base.form.asking")}</Quiet>
      </If>
      <If when={voices.status() === "success" && ready(voices, undefined)?.voices.length === 0}>
        <Quiet>{t("web.audio.emptyVoices")}</Quiet>
      </If>
      <Refusal error={error() ?? (voices.error() ? reasonOf(voices.error()) : undefined)} />
    </View>
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
      <If when={props.request}>
        {(request) => (
          <View testID="audio-request" class="min-w-0 gap-1">
            <Text class="text-xs text-muted">{t("web.audio.pending")}</Text>
            <Text class="text-xs text-muted">{`${request().id} · ${request().connection} · ${request().revision}`}</Text>
          </View>
        )}
      </If>
      <View class="flex-row flex-wrap gap-2">
        <Button testID="audio-submit" tone="primary" disabled={props.busy || (!props.request && !props.valid)} onPress={() => props.submit()}>
          {props.request ? t("web.audio.check") : props.label}
        </Button>
        <If when={props.request}>
          <ConfirmButton testid="audio-new" label={t("web.audio.new")} question={t("web.audio.newAsk")} disabled={props.busy} onConfirm={() => props.reset()} />
        </If>
      </View>
    </>
  );
}

const allFormats: readonly MediaAudioFormat[] = ["wav", "mp3", "flac", "aac", "opus", "pcm"];
const designFormats: readonly MediaAudioFormat[] = ["wav", "mp3", "flac"];

function AudioFormat(props: { value: MediaAudioFormat; disabled: boolean; design?: boolean; onChange: (value: MediaAudioFormat) => void }) {
  return (
    <Field label={t("web.audio.format")}>
      <Select
        testid="audio-format"
        label={t("web.audio.format")}
        disabled={props.disabled}
        value={props.value}
        onChange={(value) => props.onChange(value)}
        options={(props.design === true ? designFormats : allFormats).map((value) => ({ value, label: value.toUpperCase() }))}
      />
    </Field>
  );
}

function SpeakersForm(props: { status: ProviderStatus | undefined }) {
  const binding = () => props.status?.speakers;
  const scope = () => `${binding()?.connection}:${props.status?.revision}`;
  const speakers = signal([{ key: "speaker-1", id: "", voice: "", scope: "" }]);
  const segments = signal([{ key: "turn-1", speaker: "speaker-1", text: "" }]);
  const format = signal<MediaAudioFormat>("wav");
  const submitted = signal<MediaSpeakersRequest | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
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
    submitted.set(request);
    return act.run(() => api.media.dialogue.create(request));
  };

  return (
    <Card title={t("web.audio.speakerTitle")}>
      <Text class="text-sm text-muted">{t("web.audio.speakerHint")}</Text>
      <Binding connection={binding()?.connection} model={binding()?.model} revision={props.status?.revision} />
      <View class="min-w-0 gap-4">
        <Each of={speakers()} key={(speaker) => speaker.key}>
          {(speaker) => (
            <View testID="audio-speaker" class="min-w-0 gap-2">
              <Field label={t("web.audio.speaker")}>
                <TextInput
                  testID="audio-speaker-name"
                  accessibilityLabel={t("web.audio.speaker")}
                  disabled={disabled()}
                  value={speaker().id}
                  onInput={(typed) => {
                    const key = speaker().key;
                    const id = speakerId(typed);
                    speakers.set(speakers().map((item) => (item.key === key ? { ...item, id } : item)));
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
                  speakers.set(speakers().map((item) => (item.key === key ? { ...item, voice, scope: current } : item)));
                }}
              />
              <View class="flex-row">
                <Button
                  testID="audio-remove-speaker"
                  disabled={disabled() || speakers().length <= 1}
                  onPress={() => {
                    const key = speaker().key;
                    speakers.set(speakers().filter((item) => item.key !== key));
                  }}
                >
                  {t("web.audio.remove")}
                </Button>
              </View>
            </View>
          )}
        </Each>
        <View class="flex-row">
          <Button
            testID="audio-add-speaker"
            disabled={disabled() || speakers().length >= 5}
            onPress={() => speakers.set([...speakers(), { key: crypto.randomUUID(), id: "", voice: "", scope: "" }])}
          >
            {t("web.audio.addSpeaker")}
          </Button>
        </View>
        <Text class="text-sm font-semibold text-ink">{t("web.audio.dialogue")}</Text>
        <Each of={segments()} key={(segment) => segment.key}>
          {(segment) => (
            <View testID="audio-turn" class="min-w-0 gap-2">
              <Select
                testid="audio-turn-speaker"
                label={t("web.audio.speaker")}
                disabled={disabled()}
                value={segment().speaker}
                options={speakers().map((speaker) => ({ value: speaker.key, label: speaker.id || t("web.audio.speaker") }))}
                onChange={(speaker) => {
                  const key = segment().key;
                  segments.set(segments().map((item) => (item.key === key ? { ...item, speaker } : item)));
                }}
              />
              <Field label={t("web.audio.text")}>
                <TextArea
                  testID="audio-turn-text"
                  accessibilityLabel={t("web.audio.text")}
                  rows={3}
                  disabled={disabled()}
                  value={segment().text}
                  onInput={(typed) => {
                    const key = segment().key;
                    const text = typed.slice(0, 10_000);
                    segments.set(segments().map((item) => (item.key === key ? { ...item, text } : item)));
                  }}
                />
              </Field>
              <View class="flex-row">
                <Button
                  testID="audio-remove-turn"
                  disabled={disabled() || segments().length <= 1}
                  onPress={() => {
                    const key = segment().key;
                    segments.set(segments().filter((item) => item.key !== key));
                  }}
                >
                  {t("web.audio.remove")}
                </Button>
              </View>
            </View>
          )}
        </Each>
        <View class="flex-row">
          <Button
            testID="audio-add-turn"
            disabled={disabled()}
            onPress={() => {
              const speaker = speakers()[0]?.key ?? "";
              segments.set([...segments(), { key: crypto.randomUUID(), speaker, text: "" }]);
            }}
          >
            {t("web.audio.addTurn")}
          </Button>
        </View>
        <AudioFormat value={format()} disabled={disabled()} onChange={(v) => format.set(v)} />
      </View>
      <RequestActions
        request={submitted()}
        busy={act.busy()}
        valid={valid()}
        label={t("web.audio.generate")}
        submit={() => void submit()}
        reset={() => {
          submitted.set(undefined);
          error.set(undefined);
        }}
      />
      <Refusal error={error()} testid="audio-form-error" />
    </Card>
  );
}

function DesignForm(props: { status: ProviderStatus | undefined }) {
  const text = signal("");
  const instruction = signal("");
  const format = signal<MediaAudioFormat>("wav");
  const submitted = signal<MediaVoiceDesignRequest | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
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
    submitted.set(request);
    return act.run(() => api.media.voiceDesign.create(request));
  };

  return (
    <Card title={t("web.audio.designTitle")}>
      <Text class="text-sm text-muted">{t("web.audio.designHint")}</Text>
      <Binding connection={props.status?.voiceDesign?.connection} model={props.status?.voiceDesign?.model} revision={props.status?.revision} />
      <View class="min-w-0 gap-3">
        <Field label={t("web.audio.instructions")}>
          <TextArea
            testID="audio-instructions"
            accessibilityLabel={t("web.audio.instructions")}
            rows={3}
            disabled={disabled()}
            value={instruction()}
            onInput={(v) => instruction.set(v.slice(0, 10_000))}
          />
        </Field>
        <Field label={t("web.audio.previewText")}>
          <TextArea
            testID="audio-preview-text"
            accessibilityLabel={t("web.audio.previewText")}
            rows={3}
            disabled={disabled()}
            value={text()}
            onInput={(v) => text.set(v.slice(0, 10_000))}
          />
        </Field>
        <AudioFormat value={format()} design disabled={disabled()} onChange={(v) => format.set(v)} />
      </View>
      <RequestActions
        request={submitted()}
        busy={act.busy()}
        valid={Boolean(props.status?.voiceDesign && text().trim() && instruction().trim())}
        label={t("web.audio.preview")}
        submit={() => void submit()}
        reset={() => {
          submitted.set(undefined);
          error.set(undefined);
        }}
      />
      <Refusal error={error()} testid="audio-form-error" />
    </Card>
  );
}

function UploadForm(props: { kind: "clone" | "transcription"; status: ProviderStatus | undefined }) {
  const account = signal("");
  const connection = () => (props.kind === "transcription" ? (props.status?.transcription?.connection ?? "") : account());
  const selected = signal<{ file: LocalFile; input?: MediaInput } | undefined>(undefined);
  const consent = signal<{ connection: string; revision: number; file: LocalFile } | undefined>(undefined);
  const approved = () => {
    const approval = consent();
    return Boolean(approval && approval.file === selected()?.file && approval.connection === connection() && approval.revision === props.status?.revision);
  };
  const name = signal("");
  const selectedVoice = signal<{ connection: string; revision: number; id: string } | undefined>(undefined);
  const diarize = signal(true);
  const streaming = signal(false);
  const supportsStreaming = () => supportsStreamingTranscription(props.status?.transcription?.model);
  const submitted = signal<({ kind: "clone" } & MediaCloneRequest) | ({ kind: "transcription" } & MediaTranscriptionRequest) | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  let transfer: AbortController | undefined;
  cleanup(() => transfer?.abort());
  const disabled = () => act.busy() || Boolean(submitted());

  const choose = async () => {
    const picked = await act.run(pickFile);
    selected.set(picked ? { file: picked } : undefined);
    consent.set(undefined);
  };

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
    error.set(undefined);
    return act
      .run(async () => {
        if (previous)
          return previous.kind === "clone"
            ? api.media.clone.create(previous, { signal: controller.signal })
            : api.media.transcription.create(previous, { signal: controller.signal });
        if (!configuration || !chosen || !chosenConnection || !allowed) return;
        let input = chosen.input;
        if (input === undefined) {
          input = await uploadAudio(chosen.file);
          controller.signal.throwIfAborted();
          selected.set({ file: chosen.file, input });
        }
        const base = { id: crypto.randomUUID(), input: input.id, connection: chosenConnection, revision: configuration.revision };
        if (kind === "clone") {
          const request = { ...base, kind, consent: true, ...(voiceName ? { name: voiceName } : {}) } as const;
          submitted.set(request);
          return api.media.clone.create(request, { signal: controller.signal });
        }
        const request = {
          ...base,
          kind,
          allowUpload: true,
          ...(supportsStreamingTranscription(configuration.transcription?.model) ? { diarize: speakers } : {}),
          ...(stream ? { streaming: true } : {}),
        } as const;
        submitted.set(request);
        return api.media.transcription.create(request, { signal: controller.signal });
      })
      .finally(() => controller.abort());
  };

  return (
    <Card title={titleOf(props.kind)}>
      <Text class="text-sm text-muted">{props.kind === "clone" ? t("web.audio.cloneHint") : t("web.audio.transcriptionHint")}</Text>
      <If when={props.kind === "transcription"}>
        <Binding connection={connection()} model={props.status?.transcription?.model} revision={props.status?.revision} />
      </If>
      <View class="min-w-0 gap-3">
        <If when={props.kind === "clone"}>
          <Field label={t("web.audio.account")}>
            <Select
              testid="audio-account"
              label={t("web.audio.account")}
              placeholder={t("web.audio.chooseAccount")}
              value={account()}
              disabled={disabled()}
              options={(props.status?.connections ?? []).filter((item) => item.enabled).map((item) => ({ value: item.id, label: item.name }))}
              onChange={(value) => {
                account.set(value);
                consent.set(undefined);
              }}
            />
          </Field>
          <Field label={t("web.audio.voiceName")}>
            <TextInput
              testID="audio-voice-name"
              accessibilityLabel={t("web.audio.voiceName")}
              disabled={disabled()}
              value={name()}
              onInput={(v) => name.set(v.slice(0, 1000))}
            />
          </Field>
        </If>
        <Field label={t("web.audio.input")}>
          <View class="flex-row flex-wrap items-center gap-2">
            <Button testID="audio-file" icon="upload" disabled={disabled()} onPress={() => void choose()}>
              {t("web.audio.chooseFile")}
            </Button>
            <If when={selected()}>
              {(file) => (
                <Text testID="audio-file-name" class="min-w-0 flex-1 text-xs text-muted">
                  {`${file().file.name} · ${sizeText(file().file.size)}`}
                </Text>
              )}
            </If>
          </View>
        </Field>
        <If when={props.kind === "transcription"}>
          <View class="flex-row items-start gap-2">
            <Checkbox
              testid="audio-diarize"
              label={t("web.audio.diarize")}
              disabled={disabled() || !supportsStreaming()}
              checked={supportsStreaming() && diarize()}
              onChange={(v) => diarize.set(v)}
            />
            <Text class="min-w-0 flex-1 text-sm text-ink">{t("web.audio.diarize")}</Text>
          </View>
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
              onChange={(value) => streaming.set(value === "streaming")}
            />
          </Field>
        </If>
        <View class="flex-row items-start gap-2">
          <Checkbox
            testid="audio-consent"
            label={t("web.audio.consent")}
            checked={approved()}
            disabled={disabled() || !selected() || !connection()}
            onChange={(checked) => {
              const file = selected()?.file;
              const current = props.status;
              consent.set(checked && file && current && connection() ? { file, connection: connection(), revision: current.revision } : undefined);
            }}
          />
          <Text class="min-w-0 flex-1 text-sm text-ink">{t("web.audio.consent")}</Text>
        </View>
      </View>
      <If when={act.busy() && !submitted()}>
        <View class="flex-row flex-wrap items-center gap-2">
          <Text testID="audio-uploading" class="text-sm text-muted">
            {t("web.audio.uploading")}
          </Text>
          <Button testID="audio-stop-upload" onPress={() => transfer?.abort()}>
            {t("web.audio.stopUpload")}
          </Button>
        </View>
      </If>
      <RequestActions
        request={submitted()}
        busy={act.busy()}
        valid={approved() && Boolean(connection())}
        label={props.kind === "clone" ? t("web.audio.clone") : t("web.audio.transcribe")}
        submit={() => void submit()}
        reset={() => {
          submitted.set(undefined);
          consent.set(undefined);
          error.set(undefined);
        }}
      />
      <Refusal error={error()} testid="audio-form-error" />
      <If when={props.kind === "clone" && connection()}>
        <Text class="text-sm font-semibold text-ink">{t("web.audio.voices")}</Text>
        <VoicePicker
          connection={connection()}
          revision={props.status?.revision ?? 0}
          value={selectedVoice()?.connection === connection() && selectedVoice()?.revision === props.status?.revision ? (selectedVoice()?.id ?? "") : ""}
          disabled={act.busy()}
          testid="audio-account-voice"
          onChange={(id) => selectedVoice.set({ connection: connection(), revision: props.status?.revision ?? 0, id })}
        />
      </If>
    </Card>
  );
}

function AudioJobCard(props: { job: MediaAudioJob }) {
  const core = useCore();
  const error = signal<string | undefined>(undefined);
  const name = signal("");
  const saveRequest = signal<MediaCloneRequest | undefined>(undefined);
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
  const saved = signal<ArtifactId | undefined>(undefined);
  const copied = signal(false);
  const later = useTimeout();
  const cleanupPreview = signal<Preview | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const transcription = () => (props.job.result?.kind === "transcription" ? props.job.result : undefined);
  const partial = () => props.job.phase !== "ready";
  const voice = () => (props.job.result?.kind === "clone" ? props.job.result.voice : undefined);
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
      saveRequest.set(request);
      return api.media.clone.create(request);
    });
  };

  return (
    <Card title={props.job.phaseText}>
      <View testID="audio-job" class="min-w-0 gap-3">
        <Text class="text-xs font-medium text-ink">{titleOf(props.job.kind)}</Text>
        <Text class="text-xs text-muted">{[props.job.model, props.job.connection, props.job.revision, props.job.id].join(" · ")}</Text>
        <If when={props.job.format}>
          {(format) => (
            <Text testID="audio-format-result" class="text-xs text-muted">
              {`${t("web.audio.format")}: ${format().toUpperCase()}`}
            </Text>
          )}
        </If>
        <AudioMetadataLine metadata={props.job.metadata} testid="audio-metadata" />
        <SourceLine source={props.job.source} testid="audio-source" />
        <Text class="text-sm text-ink">{props.job.prompt}</Text>
        <If when={props.job.problem}>
          {(problem) => (
            <Text testID="audio-problem" class="text-sm text-muted">
              {problem()}
            </Text>
          )}
        </If>
        <ResultAudio
          attachment={props.job.attachment?.id}
          input={props.job.resultInput?.id}
          pcm={props.job.format === "pcm"}
          prefix="audio-result"
          save={t("web.audio.downloadAudio")}
        />
        <If when={props.job.kind === "voiceDesign" && props.job.previewInput !== null}>
          <Text class="text-sm text-muted">{t("web.audio.designHint")}</Text>
          <Field label={t("web.audio.voiceName")}>
            <TextInput
              testID="audio-save-name"
              accessibilityLabel={t("web.audio.voiceName")}
              disabled={act.busy() || Boolean(originalSave())}
              value={originalSave()?.name ?? name()}
              onInput={(v) => name.set(v.slice(0, 1000))}
            />
          </Field>
          <View class="flex-row">
            <Button testID="audio-save-voice" disabled={act.busy()} onPress={() => void saveVoice()}>
              {originalSave() ? t("web.audio.check") : t("web.audio.saveVoice")}
            </Button>
          </View>
        </If>
        <If when={voice()}>
          {(result) => (
            <Text testID="audio-saved-voice" class="text-sm text-ink">
              {t("web.audio.savedVoice", { voice: result().name ? `${result().name} · ${result().id}` : result().id })}
            </Text>
          )}
        </If>
        <If when={transcription()}>
          {(result) => (
            <>
              <Text class="text-sm font-semibold text-ink">{t("web.audio.transcript")}</Text>
              <If when={partial()}>
                <Text testID="audio-partial" class="text-sm text-muted">
                  {t("web.audio.partialTranscript")}
                </Text>
              </If>
              <Text testID="audio-transcript" class="text-sm text-ink">
                {result().text}
              </Text>
              <Text class="text-sm font-semibold text-ink">{t("web.audio.timeline")}</Text>
              <If when={result().segments.length > 0} else={<Quiet>{t("web.audio.noTimestamps")}</Quiet>}>
                <View testID="audio-timeline" class="min-w-0 gap-3">
                  <Each of={result().segments}>
                    {(segment) => (
                      <View class="min-w-0 gap-1">
                        <Button
                          testID={`audio-seek-${segment().start}`}
                          disabled={!props.job.input}
                          onPress={() => {
                            const input = props.job.input;
                            if (input) void act.run(() => playInput(input.id, segment().start));
                          }}
                        >
                          {`${audioTimestamp(segment().start)} – ${audioTimestamp(segment().end)}`}
                        </Button>
                        <Text class="text-xs font-medium text-ink">{segment().speaker || t("web.audio.unknownSpeaker")}</Text>
                        <Text class="text-sm text-ink">{segment().text}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
              <View class="flex-row flex-wrap items-center gap-2">
                <Button
                  testID="audio-copy-transcript"
                  icon="copy"
                  disabled={!content()}
                  onPress={() =>
                    void Clipboard.writeText(content()).then(() => {
                      copied.set(true);
                      later(() => copied.set(false), 1500);
                    })
                  }
                >
                  {copied() ? t("web.base.rich.copied") : partial() ? t("web.audio.copyPartialTranscript") : t("web.audio.copyTranscript")}
                </Button>
                <Button
                  testID="audio-save-transcript"
                  disabled={act.busy() || Boolean(saved()) || !content()}
                  onPress={() => {
                    const text = content();
                    const input = props.job.input?.name ?? props.job.id;
                    const title = partial() ? `${input} — ${t("web.audio.partialTitle")}` : input;
                    void act.run(async () => saved.set((await api.artifact.create({ title, kind: "markdown", content: text })).id));
                  }}
                >
                  {partial() ? t("web.audio.savePartialTranscript") : t("web.audio.saveTranscript")}
                </Button>
              </View>
              <If when={saved()}>
                {(id) => (
                  <TextLink href={`/artifacts/${id()}`} testid="audio-artifact">
                    {t("web.audio.openTranscript")}
                  </TextLink>
                )}
              </If>
            </>
          )}
        </If>
        <AudioUsageLine usage={props.job.usage} testid="audio-usage" />
        <If when={props.job.canRelease}>
          <ReleaseAssets id={props.job.id} />
        </If>
        <If when={props.job.canCleanup}>
          <View class="flex-row">
            <Button
              testID="audio-preview-cleanup"
              disabled={act.busy()}
              onPress={() => {
                const id = props.job.id;
                void act.run(async () => cleanupPreview.set(await api.media.audio.previewCleanup({ id })));
              }}
            >
              {t("web.audio.cleanupPreview")}
            </Button>
          </View>
          <If when={cleanupPreview()}>
            {(preview) => (
              <View class="min-w-0 gap-2">
                <View class="gap-1">
                  <Each of={preview().does}>{(step) => <Text class="text-sm text-muted">{`• ${step()}`}</Text>}</Each>
                </View>
                <ConfirmButton
                  testid="audio-cleanup"
                  label={t("web.audio.cleanup")}
                  question={t("web.audio.cleanupAsk")}
                  disabled={act.busy()}
                  onConfirm={() => {
                    const id = props.job.id;
                    void act.run(async () => {
                      await api.media.audio.cleanup({ id });
                      cleanupPreview.set(undefined);
                    });
                  }}
                />
              </View>
            )}
          </If>
        </If>
        <JobActions job={props.job} act={act} prefix="audio">
          <If when={props.job.canResume}>
            <Button
              testID="audio-resume"
              disabled={act.busy()}
              onPress={() => {
                const id = props.job.id;
                void act.run(() => api.media.audio.resume({ id }));
              }}
            >
              {t("web.audio.resume")}
            </Button>
          </If>
        </JobActions>
        <Refusal error={error()} />
      </View>
    </Card>
  );
}
