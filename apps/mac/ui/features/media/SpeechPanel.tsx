import { cleanup, computed, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { MediaAudioFormatValues, type MediaAudioFormat, type MediaSpeechJob, type MediaSpeechRequest } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { ConfirmButton } from "../../design/ConfirmButton";
import { Field, Select, TextArea } from "../../design/Field";
import { IconButton } from "../../design/IconButton";
import { Card, Quiet } from "../../design/layout";
import { Dot } from "../../design/Tag";
import { api, reasonOf } from "../../infra/api";
import { useCollabSlice, useOpsSlice } from "../../infra/frame";
import { providerQuery, providerVoicesQuery, ready, useQuery } from "../../infra/query";
import { AudioMetadataLine, AudioUsageLine, FactGrid, JobActions, NoticeBanner, PhasePill, Refusal, ResultAudio, SectionHeading, SourceLine } from "./JobFacts";
import { publicationKey } from "./publication";
import { ReleaseAssets } from "./ReleaseAssets";
import { playSpeech } from "./stream";

export function SpeechPanel() {
  const ops = useOpsSlice();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const scope = () => `${status()?.revision}:${status()?.speech?.connection}`;
  const page = signal<{ scope: string; after: string } | undefined>(undefined);
  const selected = signal<{ scope: string; id: string; name: string } | undefined>(undefined);
  const voice = () => (selected()?.scope === scope() ? selected() : undefined);
  const voices = useQuery(
    () => {
      const after = page()?.scope === scope() ? page()?.after : undefined;
      return providerVoicesQuery({
        connection: status()?.speech?.connection ?? "",
        revision: status()?.revision ?? 0,
        limit: 20,
        ...(after ? { after } : {}),
      });
    },
    { enabled: () => status()?.speech !== null && status()?.speech !== undefined },
  );
  const options = computed(() => {
    const list = (ready(voices, undefined)?.voices ?? []).map((item) => ({ value: item.id, label: item.name ? `${item.name} · ${item.id}` : item.id }));
    const chosen = voice();
    return chosen && !list.some((item) => item.value === chosen.id) ? [{ value: chosen.id, label: chosen.name }, ...list] : list;
  });
  const text = signal("");
  const format = signal<MediaAudioFormat>("wav");
  const execution = signal<"synchronous" | "asynchronous" | "streaming">("synchronous");
  const flashSupported = () => status()?.speech?.model.startsWith("moss-tts-1.5-flash") === true;
  const submitted = signal<{ request: MediaSpeechRequest; model: string; name: string } | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  let stopStream: (() => void) | undefined;
  const live = signal(false);
  const draining = signal(false);
  const stop = () => {
    stopStream?.();
    stopStream = undefined;
    live.set(false);
    draining.set(false);
  };
  cleanup(stop);
  const jobs = computed(() => ops()?.media?.filter((job): job is MediaSpeechJob => job.kind === "speech") ?? []);

  const submit = () => {
    if (act.busy()) return;
    const prev = submitted();
    if (prev) return act.run(() => api.media.speech.create(prev.request));
    const configuration = status();
    const binding = configuration?.speech;
    const chosen = voice();
    if (!configuration || !binding || !chosen || !text().trim()) return;
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
    submitted.set({
      request,
      model: binding.model,
      name: configuration.connections.find((item) => item.id === binding.connection)?.name ?? binding.connection,
    });
    return act.run(async () => {
      const job = await api.media.speech.create(request);
      if (request.streaming === true) {
        stop();
        live.set(true);
        stopStream = playSpeech(
          job.id,
          (state) => {
            draining.set(state === "done");
            if (state === "finished") live.set(false);
          },
          (why) => {
            error.set(why);
            live.set(false);
          },
        );
      }
      return job;
    });
  };

  return (
    <View testID="speech-panel" class="max-w-3xl min-w-0 gap-4">
      <Card
        title={t("web.media.speech.title")}
        action={
          <IconButton
            icon="refresh"
            label={t("web.media.speech.refresh")}
            testid="speech-refresh"
            disabled={act.busy() || query.fetching()}
            onClick={() => void act.run(() => query.refetch())}
          />
        }
      >
        <NoticeBanner tone="info">{t("web.media.speech.notice")}</NoticeBanner>
        <If when={status()?.speech} else={<NoticeBanner tone="warn">{query.error() ? reasonOf(query.error()) : t("web.media.speech.configure")}</NoticeBanner>}>
          <View class="flex-row items-center gap-2 rounded-md bg-side px-3 py-2">
            <Dot tone="leaf" size={6} ring={false} />
            <Text testID="speech-connection" class="min-w-0 flex-1 truncate font-mono text-xs text-muted tabular-nums">
              {t("web.media.speech.binding", {
                account: status()?.connections.find((item) => item.id === status()?.speech?.connection)?.name ?? "",
                connection: status()?.speech?.connection ?? "",
                model: status()?.speech?.model ?? "",
                revision: status()?.revision ?? 0,
              })}
            </Text>
          </View>
        </If>
        <View class="min-w-0 gap-3.5">
          <View class="min-w-0 gap-2">
            <Field label={t("web.media.speech.voice")} hint={t("web.media.speech.voiceHint")}>
              <Select
                label={t("web.media.speech.voice")}
                testid="speech-voice"
                placeholder={t("web.media.speech.chooseVoice")}
                disabled={act.busy() || submitted() !== undefined || voices.fetching() || !status()?.speech}
                value={voice()?.id ?? ""}
                options={options()}
                onChange={(id) => selected.set({ scope: scope(), id, name: options().find((item) => item.value === id)?.label ?? id })}
              />
            </Field>
            <If when={status()?.speech}>
              <View class="flex-row flex-wrap items-center gap-2">
                <Button
                  testID="speech-voices-first"
                  icon="refresh"
                  disabled={voices.fetching()}
                  onPress={() => {
                    const first = page()?.scope !== scope() || !page()?.after;
                    page.set(undefined);
                    if (first) void act.run(() => voices.refetch());
                  }}
                >
                  {t("web.media.speech.firstVoices")}
                </Button>
                <Button
                  testID="speech-voices-next"
                  icon="next"
                  disabled={voices.fetching() || ready(voices, undefined)?.hasMore !== true}
                  onPress={() => {
                    const after = ready(voices, undefined)?.nextCursor;
                    if (after) page.set({ scope: scope(), after });
                  }}
                >
                  {t("web.media.speech.nextVoices")}
                </Button>
                <If when={voices.fetching()}>
                  <Text class="text-xs text-muted">{t("web.base.form.asking")}</Text>
                </If>
              </View>
              <If when={voices.status() === "success" && ready(voices, undefined)?.voices.length === 0}>
                <Quiet>{t("web.media.speech.emptyVoices")}</Quiet>
              </If>
              <Refusal error={voices.error() ? reasonOf(voices.error()) : undefined} />
            </If>
          </View>
          <View class="flex-row gap-3">
            <View class="min-w-0 flex-1">
              <Field label={t("web.media.speech.format")}>
                <Select
                  label={t("web.media.speech.format")}
                  testid="speech-format"
                  disabled={act.busy() || submitted() !== undefined || execution() === "streaming"}
                  value={execution() === "streaming" ? "pcm" : format()}
                  onChange={(v) => format.set(v)}
                  options={MediaAudioFormatValues.map((value) => ({ value, label: value.toUpperCase() }))}
                />
              </Field>
            </View>
            <View class="min-w-0 flex-1">
              <Field label={t("web.media.speech.execution")}>
                <Select
                  label={t("web.media.speech.execution")}
                  testid="speech-execution"
                  disabled={act.busy() || submitted() !== undefined}
                  value={execution()}
                  onChange={(v) => execution.set(v)}
                  options={[
                    { value: "synchronous", label: t("web.media.speech.synchronous") },
                    { value: "asynchronous", label: t("web.media.speech.asynchronous") },
                    ...(flashSupported() ? [{ value: "streaming" as const, label: t("web.audio.flashTitle") }] : []),
                  ]}
                />
              </Field>
            </View>
          </View>
          <View class="min-w-0 gap-1">
            <Field label={t("web.media.speech.text")}>
              <TextArea
                testID="speech-text"
                accessibilityLabel={t("web.media.speech.text")}
                rows={5}
                disabled={act.busy() || submitted() !== undefined}
                value={text()}
                onInput={(v) => text.set(v.slice(0, 10_000))}
              />
            </Field>
            <Text class="text-right font-mono text-2xs text-faint tabular-nums">{`${text().length} / 10,000`}</Text>
          </View>
        </View>
        <If when={execution() === "streaming"}>
          <NoticeBanner tone="warn" testid="speech-flash-notice">
            {t("web.audio.flashNotice")}
          </NoticeBanner>
        </If>
        <If when={submitted()}>
          {(sent) => (
            <View testID="speech-request" class="min-w-0 gap-1 rounded-md bg-side px-3 py-2">
              <Text class="text-xs text-muted">{t("web.media.speech.pending")}</Text>
              <Text class="truncate font-mono text-2xs text-faint tabular-nums">
                {[
                  t("web.media.speech.binding", {
                    account: sent().name,
                    connection: sent().request.connection,
                    model: sent().model,
                    revision: sent().request.revision,
                  }),
                  sent().request.voice,
                  sent().request.format.toUpperCase(),
                  sent().request.id,
                ].join(" · ")}
              </Text>
            </View>
          )}
        </If>
        <View class="flex-row flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button
            testID="speech-generate"
            tone="primary"
            icon={execution() === "streaming" ? "play" : "generate"}
            disabled={act.busy() || (!submitted() && (!status()?.speech || !voice() || !text().trim()))}
            onPress={() => void submit()}
          >
            {submitted() ? t("web.media.resubmit") : execution() === "streaming" ? t("web.audio.flashStart") : t("web.media.speech.submit")}
          </Button>
          <If when={live()}>
            <Button testID="speech-flash-stop" tone="danger" icon="stop" onPress={stop}>
              {t("web.audio.flashStop")}
            </Button>
            <If when={draining()}>
              <View class="flex-row items-center gap-1.5">
                <Dot tone="water" size={6} ring={false} />
                <Text class="text-xs text-water">{t("web.audio.flashDraining")}</Text>
              </View>
            </If>
          </If>
          <If when={submitted()}>
            <ConfirmButton
              testid="speech-new"
              label={t("web.media.speech.new")}
              question={t("web.media.newAsk")}
              disabled={act.busy()}
              onConfirm={() => {
                stop();
                submitted.set(undefined);
                error.set(undefined);
              }}
            />
          </If>
        </View>
        <Refusal error={error()} testid="speech-error" />
      </Card>
      <SectionHeading title={t("web.media.speech.history")} count={jobs().length} />
      <If when={jobs().length > 0} else={<Quiet>{t("web.media.speech.empty")}</Quiet>}>
        <Each of={jobs()} key={(job) => job.id}>
          {(job) => <SpeechJobCard job={job()} />}
        </Each>
      </If>
    </View>
  );
}

function SpeechJobCard(props: { job: MediaSpeechJob }) {
  const collab = useCollabSlice();
  const channel = signal("");
  const posted = signal(false);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const failed = () => props.job.phase === "failed" || props.job.phase === "download_failed";

  const publish = (attachment: string) => {
    const id = channel();
    const job = props.job.id;
    const text = props.job.prompt;
    return act.run(async () => {
      const sendKey = await publicationKey(job, id);
      await api.channel.message.send({ id, text, attachments: [attachment], sendKey });
      posted.set(true);
    });
  };

  return (
    <Card title={props.job.voice || props.job.model} action={<PhasePill phase={props.job.phase} text={props.job.phaseText} />}>
      <View testID="speech-job" class="min-w-0 gap-3">
        <FactGrid>
          <Text testID="speech-format-result" class="font-mono text-2xs text-muted tabular-nums">
            {[props.job.model, props.job.connection, props.job.revision, props.job.voice, props.job.format.toUpperCase(), props.job.id].join(" · ")}
          </Text>
          <SourceLine source={props.job.source} testid="speech-source" />
          <AudioMetadataLine metadata={props.job.metadata} testid="speech-metadata" />
          <AudioUsageLine usage={props.job.usage} testid="speech-usage" />
        </FactGrid>
        <Text class="text-sm leading-relaxed text-ink">{props.job.prompt}</Text>
        <If when={props.job.problem}>
          {(problem) => (
            <NoticeBanner tone={failed() ? "error" : "warn"} testid="speech-problem">
              {problem()}
            </NoticeBanner>
          )}
        </If>
        <ResultAudio
          attachment={props.job.attachment?.id}
          input={props.job.resultInput?.id}
          pcm={props.job.format === "pcm"}
          prefix="speech"
          save={t("web.media.speech.save")}
          duration={props.job.metadata?.duration}
          format={props.job.format}
        />
        <If when={props.job.attachment}>
          {(file) => (
            <View class="flex-row flex-wrap items-center gap-2">
              <Select
                label={t("web.media.channel")}
                testid="speech-channel"
                size="control"
                class="w-44"
                disabled={act.busy()}
                placeholder={t("web.media.chooseChannel")}
                value={channel()}
                onChange={(v) => {
                  channel.set(v);
                  posted.set(false);
                }}
                options={(collab()?.chat?.channels ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
              />
              <Button testID="speech-publish" icon="send" disabled={act.busy() || !channel() || posted()} onPress={() => void publish(file().id)}>
                {posted() ? t("web.media.published") : t("web.media.speech.publish")}
              </Button>
            </View>
          )}
        </If>
        <If when={props.job.canRelease}>
          <ReleaseAssets id={props.job.id} />
        </If>
        <JobActions job={props.job} act={act} prefix="speech">
          <If when={props.job.canResume === true}>
            <Button
              testID="speech-resume"
              icon="retry"
              disabled={act.busy()}
              onPress={() => {
                const id = props.job.id;
                void act.run(() => api.media.speech.resume({ id }));
              }}
            >
              {t("web.media.speech.resume")}
            </Button>
          </If>
        </JobActions>
        <Refusal error={error()} />
      </View>
    </Card>
  );
}
