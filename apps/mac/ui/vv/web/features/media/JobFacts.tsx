// What every generation job's card says the same way: who asked, what the
// audio is, what the provider counted, the refusal, and the cancel / retry
// row. Read from VibeValley's ImagePanel, SpeechPanel and AudioPanel, which
// each wrote them out.
import { Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { MediaSource, MediaSpeechJob } from "@vibevalley/protocol";

import { api } from "../../infra/api";
import { playAudio, saveFile, useAttachmentFile, useInputFile } from "../../infra/attachmentFile";
import { createAct, type Act } from "../../ui/act";
import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { Quiet } from "../../ui/layout";

export function Refusal(props: { error: string | undefined; testid?: string }) {
  return (
    <If when={props.error}>
      {(why) => (
        <Text role="alert" testID={props.testid} class="text-sm text-berry">
          {why()}
        </Text>
      )}
    </If>
  );
}

export function SourceLine(props: { source: MediaSource; testid: string }) {
  return (
    <Text testID={props.testid} class="text-xs text-muted">
      {props.source.kind === "user" ? t("web.media.sourceUser") : t("web.media.sourceAgent", { agent: props.source.agent, channel: props.source.channel })}
    </Text>
  );
}

const present = (parts: readonly (string | undefined)[]) => parts.filter((part): part is string => part !== undefined).join(" · ");

export function AudioMetadataLine(props: { metadata: MediaSpeechJob["metadata"]; testid: string }) {
  return (
    <If when={props.metadata}>
      {(m) => (
        <Text testID={props.testid} class="text-xs text-muted">
          {present([
            m().source === "file" ? t("web.audio.metadataFile") : t("web.audio.metadataProvider"),
            m().sampleRate !== undefined ? t("web.audio.metadataRate", { value: m().sampleRate ?? "" }) : undefined,
            m().duration !== undefined ? t("web.audio.metadataDuration", { value: m().duration?.toFixed(3) ?? "" }) : undefined,
            m().channels !== undefined ? t("web.audio.metadataChannels", { value: m().channels ?? "" }) : undefined,
            m().bitDepth !== undefined ? t("web.audio.metadataBits", { value: m().bitDepth ?? "" }) : undefined,
          ])}
        </Text>
      )}
    </If>
  );
}

export function AudioUsageLine(props: { usage: MediaSpeechJob["usage"]; testid: string }) {
  return (
    <If when={props.usage}>
      {(u) => (
        <Text testID={props.testid} class="text-xs text-muted">
          {present([
            u().inputAudioSeconds !== undefined ? t("web.audio.usageAudioSeconds", { value: u().inputAudioSeconds ?? "" }) : undefined,
            u().inputCharacters !== undefined ? t("web.audio.usageCharacters", { value: u().inputCharacters ?? "" }) : undefined,
            u().promptTokens !== undefined ? t("web.audio.usagePrompt", { value: u().promptTokens ?? "" }) : undefined,
            u().completionTokens !== undefined ? t("web.audio.usageCompletion", { value: u().completionTokens ?? "" }) : undefined,
            u().totalTokens !== undefined ? t("web.audio.usageTotal", { value: u().totalTokens ?? "" }) : undefined,
          ])}
        </Text>
      )}
    </If>
  );
}

export function ResultAudio(props: { attachment: string | undefined; input?: string; pcm: boolean; prefix: string; save: string }) {
  const attached = useAttachmentFile(() => props.attachment ?? "");
  const input = useInputFile(() => props.input ?? "");
  const disk = () => (props.attachment ? attached() : props.input ? input() : undefined);
  const act = createAct();
  return (
    <If when={disk()}>
      {(file) => (
        <View class="flex-row flex-wrap items-center gap-2">
          <If when={props.pcm}>
            <Quiet>{t("web.media.speech.downloadOnly")}</Quiet>
          </If>
          <If when={!props.pcm}>
            <Button testID={`${props.prefix}-play`} icon="play" disabled={act.busy()} onPress={() => void act.run(() => playAudio(file().path))}>
              {t("web.library.kind.audio")}
            </Button>
          </If>
          <Button testID={`${props.prefix}-save`} disabled={act.busy()} onPress={() => void act.run(() => saveFile(file().path, file().name))}>
            {props.save}
          </Button>
        </View>
      )}
    </If>
  );
}

/** Stop waiting for it, or fetch its result again; `children` are the kind's own buttons in the same row. */
export function JobActions(props: { job: { id: string; canCancel: boolean; canRetryDownload: boolean }; act: Act; prefix: string; children?: JSX.Element }) {
  return (
    <View class="flex-row flex-wrap gap-2">
      <If when={props.job.canCancel}>
        <ConfirmButton
          testid={`${props.prefix}-cancel`}
          label={t("web.media.cancel")}
          question={t("web.media.cancelAsk")}
          disabled={props.act.busy()}
          onConfirm={() => {
            const id = props.job.id;
            void props.act.run(() => api.media.job.cancel({ id }));
          }}
        />
      </If>
      <If when={props.job.canRetryDownload}>
        <Button
          testID={`${props.prefix}-retry-download`}
          disabled={props.act.busy()}
          onPress={() => {
            const id = props.job.id;
            void props.act.run(() => api.media.job.download({ id }));
          }}
        >
          {t("web.media.retry")}
        </Button>
      </If>
      {props.children}
    </View>
  );
}
