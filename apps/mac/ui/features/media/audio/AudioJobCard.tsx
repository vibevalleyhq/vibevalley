import { Clipboard, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { MediaAudioJob, MediaCloneRequest, NoteId, Preview } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { ConfirmButton } from "../../../design/ConfirmButton";
import { Field, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { Card, Quiet } from "../../../design/layout";
import { CountPill, Dot } from "../../../design/Tag";
import { TextLink } from "../../../design/TextLink";
import { Bubble } from "../../../design/Tip";
import { createAct } from "../../../infra/act";
import { api, sha256Hex } from "../../../infra/api";
import { playInput } from "../../../infra/attachmentFile";
import { useTimeout } from "../../../infra/base/timer";
import { useOpsSlice } from "../../../infra/frame";
import { noteHref } from "../../note";
import { audioTimestamp, transcriptContent } from "../audio";
import { textToDocJson } from "../items";
import { AudioMetadataLine, AudioUsageLine, FactGrid, JobActions, NoticeBanner, PhasePill, Refusal, ResultAudio, SourceLine } from "../JobFacts";
import { ReleaseAssets } from "../ReleaseAssets";
import { audioModeTitle } from "./AudioForms";

export function AudioJobCard(props: { job: MediaAudioJob }) {
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
  const saved = signal<NoteId | undefined>(undefined);
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
    <Card title={audioModeTitle(props.job.kind)} action={<PhasePill phase={props.job.phase} text={props.job.phaseText} />}>
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
          <View class="min-w-0 gap-2.5 rounded-md border border-line bg-side p-3">
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
              <View class="min-w-0 gap-2 rounded-md border border-line bg-side p-3">
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
                      icon="notes"
                      disabled={act.busy() || Boolean(saved()) || !content()}
                      onPress={() => {
                        const text = content();
                        const input = props.job.input?.name ?? props.job.id;
                        const title = partial() ? `${input} — ${t("web.audio.partialTitle")}` : input;
                        void act.run(async () => saved.set((await api.note.create({ title, noteType: "doc", content: textToDocJson(text) })).id));
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
                    <TextLink href={noteHref(id())} testid="audio-note">
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
                            tooltip={<Bubble text={t("web.base.play")} />}
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
                <View class="min-w-0 gap-2 rounded-md border border-line bg-side p-3">
                  <View class="gap-1">
                    <Each of={preview().does} key="index">
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
