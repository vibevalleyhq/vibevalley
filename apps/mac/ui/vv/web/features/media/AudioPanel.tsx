// Ported from VibeValley apps/web/src/features/media/AudioPanel.tsx:
// multi-speaker dialogue, voice design, voice cloning and transcription.
import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { type MediaAudioFormat, type MediaAudioJob, type MediaSpeakersRequest, type MediaVoiceDesignRequest, type ProviderStatus } from "@vibevalley/protocol";

import { api, reasonOf } from "../../infra/api";
import { openAttachment, playAudio, useAttachmentFile } from "../../infra/attachmentFile";
import { useCore } from "../../infra/frame";
import { providerQuery, ready, useQuery } from "../../infra/query";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Field, Select, TextArea, TextInput } from "../../ui/Field";
import { Card, Quiet } from "../../ui/layout";
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
    <View testID="audio-panel" class="min-w-0 gap-4">
      <Text class="text-sm text-muted">{t("web.audio.notice")}</Text>
      <Button testID="audio-refresh" disabled={act.busy() || query.fetching()} onPress={() => void act.run(() => query.refetch())}>
        {t("web.audio.refresh")}
      </Button>
      <If when={error() ?? (query.error() ? reasonOf(query.error()) : undefined)}>
        {(err) => (
          <Text role="alert" testID="audio-error" class="text-sm text-berry">
            {err()}
          </Text>
        )}
      </If>
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
      <If when={mode() === "clone" || mode() === "transcription"}>
        <Card title={titleOf(mode())}>
          <Quiet>{status()?.[mode()] ? `${status()?.[mode()]?.connection} · ${status()?.[mode()]?.model}` : t("web.audio.configure")}</Quiet>
        </Card>
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

function SpeakersForm(props: { status: ProviderStatus | undefined }) {
  const binding = () => props.status?.speakers;
  const speakerName = signal("speaker-1");
  const speakerVoice = signal("");
  const turnText = signal("");
  const format = signal<MediaAudioFormat>("wav");
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));

  const submit = () => {
    const b = binding();
    const cfg = props.status;
    if (!b || !cfg || !speakerName().trim() || !speakerVoice().trim() || !turnText().trim()) return;
    const req: MediaSpeakersRequest = {
      id: crypto.randomUUID(),
      connection: b.connection,
      revision: cfg.revision,
      speakers: [{ id: speakerName().trim(), voice: speakerVoice().trim() }],
      segments: [{ speaker: speakerName().trim(), text: turnText() }],
      format: format(),
    };
    return act.run(() => api.media.dialogue.create(req));
  };

  return (
    <Card title={t("web.audio.speakerTitle")}>
      <Text class="text-sm text-muted">{t("web.audio.speakerHint")}</Text>
      <If when={binding()} else={<Quiet>{t("web.audio.configure")}</Quiet>}>
        {(b) => <Text class="text-xs text-muted">{`${b().connection} · ${b().model}`}</Text>}
      </If>
      <Field label={t("web.audio.speaker")}>
        <TextInput testID="audio-speaker-name" value={speakerName()} onInput={(e) => speakerName.set(e.currentTarget.value)} />
      </Field>
      <Field label={t("web.audio.voice")}>
        <TextInput testID="audio-speaker-voice" value={speakerVoice()} onInput={(e) => speakerVoice.set(e.currentTarget.value)} />
      </Field>
      <Field label={t("web.audio.text")}>
        <TextArea testID="audio-turn-text" rows={3} value={turnText()} onInput={(e) => turnText.set(e.currentTarget.value)} />
      </Field>
      <Field label={t("web.audio.format")}>
        <Select
          testid="audio-format"
          label={t("web.audio.format")}
          value={format()}
          onChange={(v) => format.set(v)}
          options={(["wav", "mp3", "flac", "aac", "opus", "pcm"] as const).map((v) => ({ value: v, label: v.toUpperCase() }))}
        />
      </Field>
      <Button
        testID="audio-submit"
        tone="primary"
        disabled={act.busy() || !binding() || !speakerName().trim() || !speakerVoice().trim() || !turnText().trim()}
        onPress={() => void submit()}
      >
        {t("web.audio.speakerTitle")}
      </Button>
      <If when={error()}>{(why) => <Text class="text-sm text-berry">{why()}</Text>}</If>
    </Card>
  );
}

function DesignForm(props: { status: ProviderStatus | undefined }) {
  const binding = () => props.status?.voiceDesign;
  const description = signal("");
  const sampleText = signal("");
  const format = signal<MediaAudioFormat>("wav");
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));

  const submit = () => {
    const b = binding();
    const cfg = props.status;
    if (!b || !cfg || !description().trim() || !sampleText().trim()) return;
    const req: MediaVoiceDesignRequest = {
      id: crypto.randomUUID(),
      connection: b.connection,
      revision: cfg.revision,
      voiceDescription: description(),
      text: sampleText(),
      format: format(),
    };
    return act.run(() => api.media.voiceDesign.create(req));
  };

  return (
    <Card title={t("web.audio.designTitle")}>
      <Text class="text-sm text-muted">{t("web.audio.designHint")}</Text>
      <If when={binding()} else={<Quiet>{t("web.audio.configure")}</Quiet>}>
        {(b) => <Text class="text-xs text-muted">{`${b().connection} · ${b().model}`}</Text>}
      </If>
      <Field label={t("web.audio.instructions")}>
        <TextArea testID="audio-design-description" rows={3} value={description()} onInput={(e) => description.set(e.currentTarget.value)} />
      </Field>
      <Field label={t("web.audio.text")}>
        <TextArea testID="audio-design-text" rows={3} value={sampleText()} onInput={(e) => sampleText.set(e.currentTarget.value)} />
      </Field>
      <Button
        testID="audio-design-submit"
        tone="primary"
        disabled={act.busy() || !binding() || !description().trim() || !sampleText().trim()}
        onPress={() => void submit()}
      >
        {t("web.audio.designTitle")}
      </Button>
      <If when={error()}>{(why) => <Text class="text-sm text-berry">{why()}</Text>}</If>
    </Card>
  );
}

function AudioJobCard(props: { job: MediaAudioJob }) {
  const attId = () => ("attachment" in props.job && props.job.attachment ? props.job.attachment.id : "");
  const disk = useAttachmentFile(attId);
  return (
    <Card title={props.job.phaseText}>
      <View testID="audio-job" class="min-w-0 gap-2">
        <Text class="text-xs text-muted">{`${props.job.kind} · ${props.job.model} · ${props.job.id}`}</Text>
        <If when={attId() ? attId() : undefined}>
          {(id) => (
            <View class="flex-row gap-2">
              <If when={disk()?.path}>
                {(path) => (
                  <Button icon="play" onPress={() => void playAudio(path())}>
                    {t("web.library.kind.audio")}
                  </Button>
                )}
              </If>
              <Button onPress={() => void openAttachment(id())}>{t("web.media.save")}</Button>
            </View>
          )}
        </If>
        <If when={props.job.canRelease}>
          <ReleaseAssets id={props.job.id} />
        </If>
      </View>
    </Card>
  );
}
