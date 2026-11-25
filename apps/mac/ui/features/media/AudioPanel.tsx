import { cleanup, Clipboard, computed, signal, Text, View } from "nsh";

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

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Checkbox } from "../../design/Checkbox";
import { ConfirmButton } from "../../design/ConfirmButton";
import { sizeText } from "../../design/domain/AttachmentTile";
import { Field, Select, TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Card, Quiet } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { CountPill, Dot } from "../../design/Tag";
import { TextLink } from "../../design/TextLink";
import { Bubble } from "../../design/Tip";
import { api, reasonOf, sha256Hex } from "../../infra/api";
import { type LocalFile, pickFile, playInput, uploadAudio } from "../../infra/attachmentFile";
import { useTimeout } from "../../infra/base/timer";
import { useOpsSlice } from "../../infra/frame";
import { providerQuery, providerVoicesQuery, ready, useQuery } from "../../infra/query";
import { audioTimestamp, dialogueComplete, supportsStreamingTranscription, transcriptContent } from "./audio";
import { AudioMetadataLine, AudioUsageLine, FactGrid, JobActions, NoticeBanner, PhasePill, Refusal, ResultAudio, SectionHeading, SourceLine } from "./JobFacts";
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
  const ops = useOpsSlice();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const mode = signal<AudioMode>("speakers");
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const jobs = computed(
    () =>
      ops()?.media?.filter(
        (job): job is MediaAudioJob => job.kind === "speakers" || job.kind === "voiceDesign" || job.kind === "clone" || job.kind === "transcription",
      ) ?? [],
  );
  const modeOptions = computed(() => modes.map((kind) => ({ value: kind, label: titleOf(kind) })));

  return (
    <View testID="audio-panel" accessibilityLabel={t("web.audio.title")} class="max-w-3xl min-w-0 gap-4">
      <NoticeBanner tone="info">{t("web.audio.notice")}</NoticeBanner>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Segmented testid="audio-mode" label={t("web.audio.title")} value={mode()} onChange={(kind) => mode.set(kind)} options={modeOptions()} />
        <IconButton
          icon="refresh"
          label={t("web.audio.refresh")}
          testid="audio-refresh"
          disabled={act.busy() || query.fetching()}
          onClick={() => void act.run(() => query.refetch())}
        />
      </View>
      <Refusal error={error() ?? (query.error() ? reasonOf(query.error()) : undefined)} testid="audio-error" />
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
      <SectionHeading title={t("web.audio.history")} count={jobs().length} />
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
    <If when={props.connection} else={<NoticeBanner tone="warn">{t("web.audio.configure")}</NoticeBanner>}>
      <View class="flex-row items-center gap-2 rounded-md bg-side px-3 py-2">
        <Dot tone="leaf" size={6} ring={false} />
        <Text testID="audio-binding" class="min-w-0 flex-1 truncate font-mono text-xs text-muted tabular-nums">
          {`${props.connection} · ${props.model} · ${props.revision}`}
        </Text>
      </View>
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
      <View class="flex-row gap-2.5">
        <View class="min-w-0 flex-1">
          <Field label={t("web.audio.queryVoice")} hint={t("web.audio.queryHint")}>
            <TextInput
              testID={`${props.testid}-search`}
              accessibilityLabel={t("web.audio.queryVoice")}
              disabled={props.disabled}
              value={search()}
              onInput={(v) => search.set(v)}
            />
          </Field>
        </View>
        <View class="min-w-0 flex-1">
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
        </View>
      </View>
      <View class="flex-row flex-wrap items-center gap-2">
        <Button
          testID={`${props.testid}-first`}
          icon="refresh"
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
          icon="next"
          disabled={props.disabled || voices.fetching() || ready(voices, undefined)?.hasMore !== true}
          onPress={() => {
            const after = ready(voices, undefined)?.nextCursor;
            if (after) page.set({ scope: scope(), after });
          }}
        >
          {t("web.audio.next")}
        </Button>
        <If when={voices.fetching()}>
          <Text class="text-xs text-muted">{t("web.base.form.asking")}</Text>
        </If>
      </View>
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
    <View class="min-w-0 gap-3">
      <If when={props.request}>
        {(request) => (
          <View testID="audio-request" class="min-w-0 gap-1 rounded-md bg-side px-3 py-2">
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
  const mapped = computed(() => speakers().map((speaker) => ({ id: speaker.id.trim(), voice: speaker.scope === scope() ? speaker.voice : "" })));
  const turns = computed(() => {
    const byKey = new Map(speakers().map((speaker) => [speaker.key, speaker.id.trim()]));
    return segments().map((segment) => ({
      speaker: byKey.get(segment.speaker) ?? "",
      text: segment.text,
    }));
  });
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
      <Binding connection={binding()?.connection} model={binding()?.model} revision={props.status?.revision} />
      <View class="min-w-0 gap-3">
        <Each of={speakers()} key={(speaker) => speaker.key}>
          {(speaker, idx) => (
            <View testID="audio-speaker" class="min-w-0 gap-2.5 rounded-md bg-side p-3">
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
        <View class="flex-row">
          <Button
            testID="audio-add-speaker"
            icon="add"
            disabled={disabled() || speakers().length >= 5}
            onPress={() => speakers.set([...speakers(), { key: crypto.randomUUID(), id: "", voice: "", scope: "" }])}
          >
            {t("web.audio.addSpeaker")}
          </Button>
        </View>
        <View class="flex-row items-center gap-2 border-t border-line pt-3">
          <Text class="text-sm font-semibold text-ink">{t("web.audio.dialogue")}</Text>
          <CountPill count={segments().length} />
        </View>
        <Each of={segments()} key={(segment) => segment.key}>
          {(segment, idx) => (
            <View testID="audio-turn" class="min-w-0 gap-2.5 rounded-md bg-side p-3">
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
      <Text class="text-xs leading-relaxed text-muted">{t("web.audio.designHint")}</Text>
      <Binding connection={props.status?.voiceDesign?.connection} model={props.status?.voiceDesign?.model} revision={props.status?.revision} />
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
      <Text class="text-xs leading-relaxed text-muted">{props.kind === "clone" ? t("web.audio.cloneHint") : t("web.audio.transcriptionHint")}</Text>
      <If when={props.kind === "transcription"}>
        <Binding connection={connection()} model={props.status?.transcription?.model} revision={props.status?.revision} />
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
                <View class="min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md bg-side px-2.5 py-1.5">
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
        <View class="flex-row items-start gap-2 rounded-md bg-side px-3 py-2.5">
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
        <View class="flex-row flex-wrap items-center justify-between gap-2 rounded-md bg-side px-3 py-2">
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

function AudioJobCard(props: { job: MediaAudioJob }) {
  const ops = useOpsSlice();
  const error = signal<string | undefined>(undefined);
  const name = signal("");
  const saveRequest = signal<MediaCloneRequest | undefined>(undefined);
  const originalSave = () => {
    const job = ops()?.media?.find(
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
  const failed = () => props.job.phase === "failed" || props.job.phase === "download_failed";
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
      const id = await sha256Hex(JSON.stringify(["audio-voice", job.id]));
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
    <Card title={titleOf(props.job.kind)} action={<PhasePill phase={props.job.phase} text={props.job.phaseText} />}>
      <View testID="audio-job" class="min-w-0 gap-3">
        <FactGrid>
          <Text class="font-mono text-2xs text-muted tabular-nums">
            {[props.job.model, props.job.connection, props.job.revision, props.job.id].join(" · ")}
          </Text>
          <If when={props.job.format}>
            {(format) => (
              <Text testID="audio-format-result" class="font-mono text-2xs text-muted">
                {`${t("web.audio.format")}: ${format().toUpperCase()}`}
              </Text>
            )}
          </If>
          <AudioMetadataLine metadata={props.job.metadata} testid="audio-metadata" />
          <SourceLine source={props.job.source} testid="audio-source" />
          <AudioUsageLine usage={props.job.usage} testid="audio-usage" />
        </FactGrid>
        <Text class="text-sm leading-relaxed text-ink">{props.job.prompt}</Text>
        <If when={props.job.problem}>
          {(problem) => (
            <NoticeBanner tone={failed() ? "error" : "warn"} testid="audio-problem">
              {problem()}
            </NoticeBanner>
          )}
        </If>
        <ResultAudio
          attachment={props.job.attachment?.id}
          input={props.job.resultInput?.id}
          pcm={props.job.format === "pcm"}
          prefix="audio-result"
          save={t("web.audio.downloadAudio")}
          duration={props.job.metadata?.duration}
          format={props.job.format ?? undefined}
        />
        <If when={props.job.kind === "voiceDesign" && props.job.previewInput !== null}>
          <View class="min-w-0 gap-2.5 rounded-md bg-side p-3">
            <Text class="text-xs leading-relaxed text-muted">{t("web.audio.designHint")}</Text>
            <View class="flex-row flex-wrap items-end gap-2">
              <View class="min-w-0 flex-1">
                <Field label={t("web.audio.voiceName")}>
                  <TextInput
                    testID="audio-save-name"
                    accessibilityLabel={t("web.audio.voiceName")}
                    disabled={act.busy() || Boolean(originalSave())}
                    value={originalSave()?.name ?? name()}
                    onInput={(v) => name.set(v.slice(0, 1000))}
                  />
                </Field>
              </View>
              <Button testID="audio-save-voice" disabled={act.busy()} onPress={() => void saveVoice()}>
                {originalSave() ? t("web.audio.check") : t("web.audio.saveVoice")}
              </Button>
            </View>
          </View>
        </If>
        <If when={voice()}>
          {(result) => (
            <View class="flex-row items-center gap-2 rounded-md bg-ok-soft px-3 py-2">
              <Icon name="check" size={12} />
              <Text testID="audio-saved-voice" class="min-w-0 flex-1 text-xs font-medium text-ok-ink">
                {t("web.audio.savedVoice", { voice: result().name ? `${result().name} · ${result().id}` : result().id })}
              </Text>
            </View>
          )}
        </If>
        <If when={transcription()}>
          {(result) => (
            <View class="min-w-0 gap-3">
              <View class="min-w-0 gap-2 rounded-md bg-side p-3">
                <View class="flex-row flex-wrap items-center justify-between gap-2">
                  <Text class="text-xs font-semibold text-ink">{t("web.audio.transcript")}</Text>
                  <View class="flex-row flex-wrap items-center gap-1.5">
                    <IconButton
                      icon={copied() ? "check" : "copy"}
                      label={copied() ? t("web.base.rich.copied") : partial() ? t("web.audio.copyPartialTranscript") : t("web.audio.copyTranscript")}
                      testid="audio-copy-transcript"
                      disabled={!content()}
                      onClick={() =>
                        void Clipboard.writeText(content()).then(() => {
                          copied.set(true);
                          later(() => copied.set(false), 1500);
                        })
                      }
                    />
                    <Button
                      testID="audio-save-transcript"
                      icon="artifacts"
                      disabled={act.busy() || Boolean(saved()) || !content()}
                      onPress={() => {
                        const text = content();
                        const input = props.job.input?.name ?? props.job.id;
                        const title = partial() ? `${input} — ${t("web.audio.partialTitle")}` : input;
                        void act.run(async () => saved.set((await api.artifact.create({ title, artifactType: "docs", content: text })).id));
                      }}
                    >
                      {partial() ? t("web.audio.savePartialTranscript") : t("web.audio.saveTranscript")}
                    </Button>
                  </View>
                </View>
                <If when={partial()}>
                  <NoticeBanner tone="warn" testid="audio-partial">
                    {t("web.audio.partialTranscript")}
                  </NoticeBanner>
                </If>
                <Text testID="audio-transcript" class="text-sm leading-relaxed text-ink select-text">
                  {result().text}
                </Text>
                <If when={saved()}>
                  {(id) => (
                    <TextLink href={`/artifacts/${id()}`} testid="audio-artifact">
                      {t("web.audio.openTranscript")}
                    </TextLink>
                  )}
                </If>
              </View>
              <View class="min-w-0 gap-2">
                <View class="flex-row items-center gap-2">
                  <Text class="text-xs font-semibold text-muted">{t("web.audio.timeline")}</Text>
                  <If when={result().segments.length > 0}>
                    <CountPill count={result().segments.length} />
                  </If>
                </View>
                <If when={result().segments.length > 0} else={<Quiet>{t("web.audio.noTimestamps")}</Quiet>}>
                  <View testID="audio-timeline" class="min-w-0 gap-1">
                    <Each of={result().segments} key={(s) => `${s.start}:${s.end}`}>
                      {(segment) => (
                        <View class="flex-row items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
                          <View
                            role="button"
                            testID={`audio-seek-${segment().start}`}
                            accessibilityLabel={`${audioTimestamp(segment().start)} – ${audioTimestamp(segment().end)}`}
                            tooltip={<Bubble text={t("web.catalog.play")} />}
                            disabled={!props.job.input}
                            onPress={() => {
                              const input = props.job.input;
                              if (input) void act.run(() => playInput(input.id, segment().start));
                            }}
                            class={`mt-0.5 h-6 shrink-0 flex-row items-center gap-1 rounded-sm border border-line bg-page px-1.5 ${
                              !props.job.input ? "opacity-50" : "hover:bg-selected active:translate-y-px"
                            }`}
                          >
                            <Icon name="play" size={10} tone="muted" />
                            <Text class="font-mono text-2xs text-ink tabular-nums">
                              {`${audioTimestamp(segment().start)} – ${audioTimestamp(segment().end)}`}
                            </Text>
                          </View>
                          <View class="min-w-0 flex-1 gap-0.5">
                            <Text class={`text-xs font-medium ${segment().speaker ? "text-water" : "text-faint"}`}>
                              {segment().speaker || t("web.audio.unknownSpeaker")}
                            </Text>
                            <Text class="text-sm text-ink">{segment().text}</Text>
                          </View>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
              </View>
            </View>
          )}
        </If>
        <If when={props.job.canRelease}>
          <ReleaseAssets id={props.job.id} />
        </If>
        <If when={props.job.canCleanup}>
          <View class="min-w-0 gap-2">
            <View class="flex-row">
              <Button
                testID="audio-preview-cleanup"
                icon="show"
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
                <View class="min-w-0 gap-2 rounded-md bg-side p-3">
                  <View class="gap-1">
                    <Each of={preview().does}>
                      {(step) => (
                        <View class="flex-row items-start gap-2 rounded-sm bg-page px-2.5 py-1.5">
                          <View class="mt-1.5 shrink-0">
                            <Dot tone="muted" size={5} ring={false} />
                          </View>
                          <Text class="min-w-0 flex-1 text-xs text-ink">{step()}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                  <View class="flex-row flex-wrap items-center gap-2">
                    <ConfirmButton
                      testid="audio-cleanup"
                      tone="danger"
                      icon="delete"
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
                    <Button tone="quiet" disabled={act.busy()} onPress={() => cleanupPreview.set(undefined)}>
                      {t("web.base.form.never")}
                    </Button>
                  </View>
                </View>
              )}
            </If>
          </View>
        </If>
        <JobActions job={props.job} act={act} prefix="audio">
          <If when={props.job.canResume}>
            <Button
              testID="audio-resume"
              icon="retry"
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
