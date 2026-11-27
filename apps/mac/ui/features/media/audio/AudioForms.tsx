import { cleanup, computed, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import {
  MediaAudioFormatValues,
  type MediaAudioAccountRequest,
  type MediaAudioFormat,
  type MediaAudioJob,
  type MediaCloneRequest,
  type MediaInput,
  type MediaJob,
  type MediaSpeakersRequest,
  type MediaTranscriptionRequest,
  type MediaVoiceDesignRequest,
  type ProviderStatus,
} from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Checkbox } from "../../../design/Checkbox";
import { ConfirmButton } from "../../../design/ConfirmButton";
import { sizeText } from "../../../design/domain/AttachmentTile";
import { Field, Select, TextArea, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import type { IconName } from "../../../design/icons";
import { Card } from "../../../design/layout";
import { CountPill, Dot } from "../../../design/Tag";
import { createAct } from "../../../infra/act";
import { api } from "../../../infra/api";
import { type LocalFile, pickFile, uploadAudio } from "../../../infra/attachmentFile";
import { dialogueComplete, supportsStreamingTranscription } from "../audio";
import { NoticeBanner, Refusal } from "../JobFacts";
import { VoicePicker } from "./VoicePicker";

export type AudioMode = MediaAudioJob["kind"];

const modeMeta: Record<AudioMode, { readonly icon: IconName; readonly title: () => string }> = {
  speakers: { icon: "agents", title: () => t("web.audio.speakerTitle") },
  voiceDesign: { icon: "appearance", title: () => t("web.audio.designTitle") },
  clone: { icon: "record", title: () => t("web.audio.cloneTitle") },
  transcription: { icon: "audio", title: () => t("web.audio.transcriptionTitle") },
};

const isAudioMode = (kind: string): kind is AudioMode => kind in modeMeta;
export const audioModes: readonly AudioMode[] = Object.keys(modeMeta).filter(isAudioMode);
export const audioModeTitle = (kind: AudioMode) => modeMeta[kind].title();
export const audioModeIcon = (kind: AudioMode): IconName => modeMeta[kind].icon;
export const isAudioJob = (job: MediaJob): job is MediaAudioJob => job.kind in modeMeta;

const speakerId = (typed: string) => typed.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 256);

const isDesignFormat = (format: MediaAudioFormat): format is "wav" | "mp3" | "flac" => format === "wav" || format === "mp3" || format === "flac";
const allFormats = MediaAudioFormatValues;
const designFormats = MediaAudioFormatValues.filter(isDesignFormat);

function Binding(props: {
  connection: string | undefined;
  revision: number | undefined;
  model: string | undefined;
  connections?: ProviderStatus["connections"] | undefined;
}) {
  const accountName = () => {
    const id = props.connection;
    if (!id) return undefined;
    const found = props.connections?.find((item) => item.id === id)?.name;
    return found && found !== id ? found : undefined;
  };
  return (
    <If when={props.connection} else={<NoticeBanner tone="warn">{t("web.audio.configure")}</NoticeBanner>}>
      <View class="flex-row items-center gap-2 rounded-md border border-line bg-side px-3 py-2">
        <Dot tone="leaf" size={6} ring={false} />
        <If when={accountName()}>{(name) => <Text class="shrink-0 text-xs font-medium text-ink">{name()}</Text>}</If>
        <Text testID="audio-binding" class="min-w-0 flex-1 truncate font-mono text-xs text-muted tabular-nums">
          {`${props.connection} · ${props.model} · ${props.revision}`}
        </Text>
      </View>
    </If>
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
    <View class="min-w-0 gap-3">
      <If when={props.request}>
        {(request) => (
          <View testID="audio-request" class="min-w-0 gap-1 rounded-md border border-line bg-side px-3 py-2">
            <Text class="text-xs text-muted">{t("web.audio.pending")}</Text>
            <Text class="truncate font-mono text-2xs text-faint tabular-nums">{`${request().id} · ${request().connection} · ${request().revision}`}</Text>
          </View>
        )}
      </If>
      <View class="flex-row flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button testID="audio-submit" tone="primary" icon="generate" disabled={props.busy || (!props.request && !props.valid)} onPress={() => props.submit()}>
          {props.request ? t("web.audio.check") : props.label}
        </Button>
        <If when={props.request}>
          <ConfirmButton testid="audio-new" label={t("web.audio.new")} question={t("web.audio.newAsk")} disabled={props.busy} onConfirm={() => props.reset()} />
        </If>
      </View>
    </View>
  );
}

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

export function SpeakersForm(props: { status: ProviderStatus | undefined }) {
  const binding = () => props.status?.speakers;
  const scope = () => `${binding()?.connection}:${props.status?.revision}`;
  const speakers = signal([{ key: "speaker-1", id: "", voice: "", scope: "" }]);
  const segments = signal([{ key: "turn-1", speaker: "speaker-1", text: "" }]);
  const format = signal<MediaAudioFormat>("wav");
  const submitted = signal<MediaSpeakersRequest | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const mapped = computed(() => speakers().map((speaker) => ({ id: speaker.id.trim(), voice: speaker.scope === scope() ? speaker.voice : "" })));
  const turns = computed(() => {
    const byKey = new Map(speakers().map((speaker) => [speaker.key, speaker.id.trim()]));
    return segments().map((segment) => ({
      speaker: byKey.get(segment.speaker) ?? "",
      text: segment.text,
    }));
  });
  const totalChars = computed(() => segments().reduce((sum, segment) => sum + segment.text.length, 0));
  const valid = computed(() => Boolean(binding()) && dialogueComplete(mapped(), turns()));
  const disabled = computed(() => act.busy() || Boolean(submitted()));

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
      <Text class="text-xs leading-relaxed text-muted">{t("web.audio.speakerHint")}</Text>
      <Binding connection={binding()?.connection} model={binding()?.model} revision={props.status?.revision} connections={props.status?.connections} />
      <View class="min-w-0 gap-3">
        <Each of={speakers()} key={(speaker) => speaker.key}>
          {(speaker, idx) => (
            <View testID="audio-speaker" class="min-w-0 gap-2.5 rounded-md border border-line bg-side p-3">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="font-mono text-2xs font-semibold text-muted tabular-nums">{`${t("web.audio.speaker")} #${idx() + 1}`}</Text>
                <IconButton
                  icon="delete"
                  tone="danger"
                  label={t("web.audio.remove")}
                  testid="audio-remove-speaker"
                  disabled={disabled() || speakers().length <= 1}
                  onClick={() => {
                    const key = speaker().key;
                    speakers.set(speakers().filter((item) => item.key !== key));
                  }}
                />
              </View>
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
            </View>
          )}
        </Each>
        <View class="flex-row items-center gap-2">
          <Button
            testID="audio-add-speaker"
            icon="add"
            disabled={disabled() || speakers().length >= 5}
            onPress={() => speakers.set([...speakers(), { key: crypto.randomUUID(), id: "", voice: "", scope: "" }])}
          >
            {t("web.audio.addSpeaker")}
          </Button>
          <Text class="font-mono text-2xs text-faint tabular-nums">{`${speakers().length} / 5`}</Text>
        </View>
        <View class="flex-row items-center justify-between gap-2 border-t border-line pt-3">
          <View class="flex-row items-center gap-2">
            <Text class="text-sm font-semibold text-ink">{t("web.audio.dialogue")}</Text>
            <CountPill count={segments().length} />
          </View>
          <Text class={`font-mono text-2xs tabular-nums ${totalChars() > 10_000 ? "text-berry" : "text-faint"}`}>{`${totalChars()} / 10,000`}</Text>
        </View>
        <Each of={segments()} key={(segment) => segment.key}>
          {(segment, idx) => (
            <View testID="audio-turn" class="min-w-0 gap-2.5 rounded-md border border-line bg-side p-3">
              <View class="flex-row items-center gap-2">
                <Text class="w-6 shrink-0 font-mono text-2xs font-semibold text-faint tabular-nums">{`#${idx() + 1}`}</Text>
                <View class="min-w-0 flex-1">
                  <Select
                    testid="audio-turn-speaker"
                    label={t("web.audio.speaker")}
                    size="control"
                    disabled={disabled()}
                    value={segment().speaker}
                    options={speakers().map((speaker) => ({ value: speaker.key, label: speaker.id || t("web.audio.speaker") }))}
                    onChange={(speaker) => {
                      const key = segment().key;
                      segments.set(segments().map((item) => (item.key === key ? { ...item, speaker } : item)));
                    }}
                  />
                </View>
                <IconButton
                  icon="delete"
                  tone="danger"
                  label={t("web.audio.remove")}
                  testid="audio-remove-turn"
                  disabled={disabled() || segments().length <= 1}
                  onClick={() => {
                    const key = segment().key;
                    segments.set(segments().filter((item) => item.key !== key));
                  }}
                />
              </View>
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
            </View>
          )}
        </Each>
        <View class="flex-row">
          <Button
            testID="audio-add-turn"
            icon="add"
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

export function DesignForm(props: { status: ProviderStatus | undefined }) {
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
      <Text class="text-xs leading-relaxed text-muted">{t("web.audio.designHint")}</Text>
      <Binding
        connection={props.status?.voiceDesign?.connection}
        model={props.status?.voiceDesign?.model}
        revision={props.status?.revision}
        connections={props.status?.connections}
      />
      <View class="min-w-0 gap-3.5">
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

export function UploadForm(props: { kind: "clone" | "transcription"; status: ProviderStatus | undefined }) {
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
    <Card title={audioModeTitle(props.kind)}>
      <Text class="text-xs leading-relaxed text-muted">{props.kind === "clone" ? t("web.audio.cloneHint") : t("web.audio.transcriptionHint")}</Text>
      <If when={props.kind === "transcription"}>
        <Binding
          connection={connection()}
          model={props.status?.transcription?.model}
          revision={props.status?.revision}
          connections={props.status?.connections}
        />
      </If>
      <View class="min-w-0 gap-3.5">
        <If when={props.kind === "clone"}>
          <View class="flex-row gap-3">
            <View class="min-w-0 flex-1">
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
            </View>
            <View class="min-w-0 flex-1">
              <Field label={t("web.audio.voiceName")}>
                <TextInput
                  testID="audio-voice-name"
                  accessibilityLabel={t("web.audio.voiceName")}
                  disabled={disabled()}
                  value={name()}
                  onInput={(v) => name.set(v.slice(0, 1000))}
                />
              </Field>
            </View>
          </View>
        </If>
        <Field label={t("web.audio.input")}>
          <View class="flex-row flex-wrap items-center gap-2">
            <Button testID="audio-file" icon="upload" disabled={disabled()} onPress={() => void choose()}>
              {t("web.audio.chooseFile")}
            </Button>
            <If when={selected()}>
              {(file) => (
                <View class="min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md border border-line bg-side px-2.5 py-1.5">
                  <Icon name="audio" size={14} tone="muted" />
                  <Text testID="audio-file-name" class="min-w-0 flex-1 truncate text-xs text-ink tabular-nums">
                    {`${file().file.name} · ${sizeText(file().file.size)}`}
                  </Text>
                </View>
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
        <View class="flex-row items-start gap-2 rounded-md border border-line bg-side px-3 py-2.5">
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
          <Text class="min-w-0 flex-1 text-xs leading-relaxed text-ink">{t("web.audio.consent")}</Text>
        </View>
      </View>
      <If when={act.busy() && !submitted()}>
        <View class="flex-row flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-side px-3 py-2">
          <View class="flex-row items-center gap-2">
            <Dot tone="water" size={6} ring={false} />
            <Text testID="audio-uploading" class="text-xs text-water">
              {t("web.audio.uploading")}
            </Text>
          </View>
          <Button testID="audio-stop-upload" tone="danger" icon="stop" onPress={() => transfer?.abort()}>
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
        <View class="min-w-0 gap-2 border-t border-line pt-3">
          <Text class="text-sm font-semibold text-ink">{t("web.audio.voices")}</Text>
          <VoicePicker
            connection={connection()}
            revision={props.status?.revision ?? 0}
            value={selectedVoice()?.connection === connection() && selectedVoice()?.revision === props.status?.revision ? (selectedVoice()?.id ?? "") : ""}
            disabled={act.busy()}
            testid="audio-account-voice"
            onChange={(id) => selectedVoice.set({ connection: connection(), revision: props.status?.revision ?? 0, id })}
          />
        </View>
      </If>
    </Card>
  );
}
