// What every generation job's card says the same way: who asked, what the
// audio is, what the provider counted, the refusal, and the cancel / retry
// row. Read from VibeValley's ImagePanel, SpeechPanel and AudioPanel, which
// each wrote them out.
import { cleanup, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { MediaAudioFormat, MediaJob, MediaSource, MediaSpeechJob } from "@vibevalley/protocol";

import { hostApi } from "../../../../bridge";
import { api } from "../../infra/api";
import { playAudio, saveFile, useAttachmentFile, useInputFile } from "../../infra/attachmentFile";
import { createAct, type Act } from "../../ui/act";
import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { Icon } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";
import { Dot, type DotTone } from "../../ui/Tag";
import { Bubble } from "../../ui/Tip";
import { mix } from "../../ui/tone";
import { audioTimestamp } from "./audio";

type AnyPhase = MediaJob["phase"];

interface PhaseStyle {
  readonly bg: () => string;
  readonly text: string;
  readonly glyph: "check" | "cross" | "dot";
  readonly dot?: DotTone;
}

function phaseStyleOf(phase: AnyPhase): PhaseStyle {
  switch (phase) {
    case "ready":
      return { bg: () => mix("ok-soft", 1), text: "text-ok-ink", glyph: "check" };
    case "queued":
    case "uploading":
    case "generating":
    case "downloading":
      return { bg: () => mix("water", 0.14), text: "text-water", glyph: "dot", dot: "water" };
    case "authorized":
    case "incomplete":
    case "unknown":
      return { bg: () => mix("wheat", 0.22), text: "text-warn-ink", glyph: "dot", dot: "wheat" };
    case "failed":
    case "download_failed":
      return { bg: () => mix("bad-soft", 1), text: "text-berry", glyph: "cross" };
    case "canceled":
      return { bg: () => mix("hover", 1), text: "text-muted", glyph: "dot", dot: "muted" };
  }
}

export function PhasePill(props: { phase: AnyPhase; text: string }) {
  const style = () => phaseStyleOf(props.phase);
  return (
    <View class="shrink-0 flex-row items-center gap-1.5 rounded-sm px-2 py-0.5" style={{ backgroundColor: style().bg() }}>
      <If when={style().glyph === "check"}>
        <Icon name="check" size={12} />
      </If>
      <If when={style().glyph === "cross"}>
        <Icon name="cross" size={12} />
      </If>
      <If when={style().glyph === "dot"}>
        <Dot tone={style().dot ?? "muted"} size={6} ring={false} />
      </If>
      <Text class={`text-2xs font-medium ${style().text}`}>{props.text}</Text>
    </View>
  );
}

type BannerTone = "info" | "warn" | "error";

const bannerStyles: Record<
  BannerTone,
  { readonly bg: () => string; readonly border: () => string; readonly text: string; readonly icon: IconName; readonly iconTone: string }
> = {
  info: { bg: () => mix("side", 1), border: () => mix("line", 1), text: "text-muted", icon: "info", iconTone: "muted" },
  warn: { bg: () => mix("wheat", 0.14), border: () => mix("wheat", 0.35), text: "text-ink", icon: "warn", iconTone: "warn-ink" },
  error: { bg: () => mix("bad-soft", 1), border: () => mix("berry", 0.3), text: "text-berry", icon: "cross", iconTone: "berry" },
};

export function NoticeBanner(props: { tone?: BannerTone; icon?: IconName; testid?: string; role?: "alert"; children: JSX.Element }) {
  const s = () => bannerStyles[props.tone ?? "info"];
  return (
    <View class="flex-row items-start gap-2 rounded-md border px-3 py-2" style={{ backgroundColor: s().bg(), borderColor: s().border() }}>
      <View class="mt-0.5 shrink-0">
        <Icon name={props.icon ?? s().icon} size={12} tone={s().iconTone} />
      </View>
      <If when={typeof props.children === "string"} else={<View class="min-w-0 flex-1">{props.children}</View>}>
        <Text
          role={props.role}
          testID={props.testid}
          class={`min-w-0 flex-1 text-xs leading-relaxed ${props.tone === "error" ? "font-medium" : ""} ${s().text}`}
        >
          {props.children as string}
        </Text>
      </If>
    </View>
  );
}

export function FactGrid(props: { children: JSX.Element }) {
  return <View class="min-w-0 gap-1.5 rounded-md bg-side px-3 py-2">{props.children}</View>;
}

export function FactRow(props: { label: string; children: JSX.Element }) {
  return (
    <View class="flex-row items-baseline gap-2.5">
      <Text class="w-16 shrink-0 text-2xs text-faint">{props.label}</Text>
      <View class="min-w-0 flex-1">
        <If when={typeof props.children === "string"} else={props.children}>
          <Text class="truncate font-mono text-2xs text-muted tabular-nums">{props.children as string}</Text>
        </If>
      </View>
    </View>
  );
}

export function SectionHeading(props: { title: string; count?: number }) {
  return (
    <View class="flex-row items-center gap-2 pt-1">
      <Text role="header" class="text-base font-semibold text-ink">
        {props.title}
      </Text>
      <If when={props.count !== undefined && props.count > 0}>
        <View class="rounded-full bg-hover px-2 py-px">
          <Text class="text-2xs font-medium text-muted tabular-nums">{String(props.count ?? 0)}</Text>
        </View>
      </If>
    </View>
  );
}

export function Refusal(props: { error: string | undefined; testid?: string }) {
  return (
    <If when={props.error}>
      {(why) => (
        <NoticeBanner tone="error" role="alert" testid={props.testid}>
          {why()}
        </NoticeBanner>
      )}
    </If>
  );
}

export function SourceLine(props: { source: MediaSource; testid: string }) {
  return (
    <View class="flex-row items-center gap-1.5">
      <Icon name={props.source.kind === "user" ? "agents" : "chat"} size={12} tone="faint" />
      <Text testID={props.testid} class="min-w-0 flex-1 truncate text-xs text-muted">
        {props.source.kind === "user" ? t("web.media.sourceUser") : t("web.media.sourceAgent", { agent: props.source.agent, channel: props.source.channel })}
      </Text>
    </View>
  );
}

const present = (parts: readonly (string | undefined)[]) => parts.filter((part): part is string => part !== undefined).join(" · ");

export function AudioMetadataLine(props: { metadata: MediaSpeechJob["metadata"]; testid: string }) {
  return (
    <If when={props.metadata}>
      {(m) => (
        <Text testID={props.testid} class="font-mono text-2xs text-muted tabular-nums">
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
        <Text testID={props.testid} class="font-mono text-2xs text-muted tabular-nums">
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

export function ResultAudio(props: {
  attachment: string | undefined;
  input?: string;
  pcm: boolean;
  prefix: string;
  save: string;
  duration?: number | undefined;
  format?: MediaAudioFormat | null | undefined;
}) {
  const attached = useAttachmentFile(() => props.attachment ?? "");
  const input = useInputFile(() => props.input ?? "");
  const disk = () => (props.attachment ? attached() : props.input ? input() : undefined);
  const playing = signal(false);
  const act = createAct();
  cleanup(() => {
    if (playing()) {
      playing.set(false);
      void hostApi.stopAudio();
    }
  });
  const togglePlay = (path: string) => {
    if (playing()) {
      playing.set(false);
      void act.run(() => hostApi.stopAudio());
      return;
    }
    playing.set(true);
    void act.run(async () => {
      try {
        await playAudio(path);
      } catch (e) {
        playing.set(false);
        throw e;
      }
    });
  };
  return (
    <If when={disk()}>
      {(file) => (
        <View class="flex-row flex-wrap items-center gap-2.5 rounded-md border border-line bg-side px-2.5 py-2">
          <If when={props.pcm}>
            <View class="min-w-0 flex-1 flex-row items-center gap-2">
              <Icon name="audio" size={14} tone="muted" />
              <Text class="min-w-0 flex-1 text-xs text-muted">{t("web.media.speech.downloadOnly")}</Text>
            </View>
          </If>
          <If when={!props.pcm}>
            <View
              role="button"
              testID={`${props.prefix}-play`}
              accessibilityLabel={playing() ? t("web.catalog.stop") : t("web.catalog.play")}
              tooltip={<Bubble text={playing() ? t("web.catalog.stop") : t("web.catalog.play")} />}
              disabled={act.busy()}
              onPress={() => togglePlay(file().path)}
              class={`size-7 shrink-0 items-center justify-center rounded-md border transition duration-120 ease-out active:translate-y-px ${
                playing() ? "border-accent bg-ok-soft" : "border-line bg-page hover:bg-hover"
              } ${act.busy() ? "opacity-50" : ""}`}
            >
              <Icon name={playing() ? "stop" : "play"} size={14} tone={playing() ? "ok-ink" : "ink"} />
            </View>
            <View class="min-w-0 flex-1 gap-1">
              <View class="flex-row items-center gap-2">
                <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{file().name || t("web.library.kind.audio")}</Text>
                <If when={props.format}>
                  {(fmt) => (
                    <View class="shrink-0 rounded-xs bg-hover px-1 py-px">
                      <Text class="font-mono text-2xs font-medium text-muted">{fmt().toUpperCase()}</Text>
                    </View>
                  )}
                </If>
                <If when={props.duration !== undefined}>
                  <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{audioTimestamp(props.duration ?? 0)}</Text>
                </If>
              </View>
              <View class="h-1.5 w-full overflow-hidden rounded-full bg-hover">
                <View class={`h-full rounded-full ${playing() ? "w-full bg-accent" : "w-0 bg-accent"}`} />
              </View>
            </View>
          </If>
          <View tooltip={<Bubble text={props.save} />}>
            <Button
              testID={`${props.prefix}-save`}
              icon="download"
              disabled={act.busy()}
              onPress={() => void act.run(() => saveFile(file().path, file().name))}
            >
              {props.save}
            </Button>
          </View>
        </View>
      )}
    </If>
  );
}

/** Stop waiting for it, or fetch its result again; `children` are the kind's own buttons in the same row. */
export function JobActions(props: { job: { id: string; canCancel: boolean; canRetryDownload: boolean }; act: Act; prefix: string; children?: JSX.Element }) {
  return (
    <View class="flex-row flex-wrap items-center gap-2">
      <If when={props.job.canCancel}>
        <ConfirmButton
          testid={`${props.prefix}-cancel`}
          icon="close"
          tone="danger"
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
          icon="retry"
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
