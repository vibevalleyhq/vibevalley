// Ported from VibeValley apps/web/src/features/media/SpeechPanel.tsx. Not
// here: Flash live playback (FlashPlayer). It plays PCM as it arrives, which
// neither nsh nor the host can: the execution is offered and says so.
import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { MediaAudioFormatValues, type MediaAudioFormat, type MediaSpeechJob, type MediaSpeechRequest, type ProviderVoiceRequest } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { api, reasonOf } from "../../infra/api";
import { useCore } from "../../infra/frame";
import { defineQuery, providerQuery, ready, useQuery } from "../../infra/query";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { Field, Select, TextArea } from "../../ui/Field";
import { Card, Quiet } from "../../ui/layout";
import { AudioMetadataLine, AudioUsageLine, JobActions, Refusal, ResultAudio, SourceLine } from "./JobFacts";
import { publicationKey } from "./publication";
import { ReleaseAssets } from "./ReleaseAssets";

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
  const page = signal<{ scope: string; after: string } | undefined>(undefined);
  const selected = signal<{ scope: string; id: string; name: string } | undefined>(undefined);
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
  const text = signal("");
  const format = signal<MediaAudioFormat>("wav");
  const execution = signal<"synchronous" | "asynchronous" | "streaming">("synchronous");
  const flashSupported = () => status()?.speech?.model.startsWith("moss-tts-1.5-flash") === true;
  const submitted = signal<{ request: MediaSpeechRequest; model: string; name: string } | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const jobs = () => core()?.media?.filter((job): job is MediaSpeechJob => job.kind === "speech") ?? [];

  const submit = () => {
    if (act.busy()) return;
    const prev = submitted();
    if (prev) return act.run(() => api.media.speech.create(prev.request));
    const configuration = status();
    const binding = configuration?.speech;
    const chosen = voice();
    if (!configuration || !binding || !chosen || !text().trim() || execution() === "streaming") return;
    const request: MediaSpeechRequest = {
      id: crypto.randomUUID(),
      text: text(),
      voice: chosen.id,
      format: format(),
      asynchronous: execution() === "asynchronous",
      streaming: false,
      connection: binding.connection,
      revision: configuration.revision,
    };
    submitted.set({
      request,
      model: binding.model,
      name: configuration.connections.find((item) => item.id === binding.connection)?.name ?? binding.connection,
    });
    return act.run(() => api.media.speech.create(request));
  };

  return (
    <View testID="speech-panel" class="min-w-0 gap-4">
      <Card title={t("web.media.speech.title")}>
        <Text class="text-sm text-muted">{t("web.media.speech.notice")}</Text>
        <If when={status()?.speech} else={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.media.speech.configure")}</Quiet>}>
          <Text testID="speech-connection" class="text-xs text-muted">
            {t("web.media.speech.binding", {
              account: status()?.connections.find((item) => item.id === status()?.speech?.connection)?.name ?? "",
              connection: status()?.speech?.connection ?? "",
              model: status()?.speech?.model ?? "",
              revision: status()?.revision ?? 0,
            })}
          </Text>
        </If>
        <Button testID="speech-refresh" disabled={act.busy() || query.fetching()} onPress={() => void act.run(() => query.refetch())}>
          {t("web.media.speech.refresh")}
        </Button>
        <View class="min-w-0 gap-3">
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
            <View class="flex-row flex-wrap gap-2">
              <Button
                testID="speech-voices-first"
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
                disabled={voices.fetching() || ready(voices, undefined)?.hasMore !== true}
                onPress={() => {
                  const after = ready(voices, undefined)?.nextCursor;
                  if (after) page.set({ scope: scope(), after });
                }}
              >
                {t("web.media.speech.nextVoices")}
              </Button>
            </View>
            <If when={voices.fetching()}>
              <Quiet>{t("web.base.form.asking")}</Quiet>
            </If>
            <If when={voices.status() === "success" && ready(voices, undefined)?.voices.length === 0}>
              <Quiet>{t("web.media.speech.emptyVoices")}</Quiet>
            </If>
            <Refusal error={voices.error() ? reasonOf(voices.error()) : undefined} />
          </If>
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
        </View>
        <If when={execution() === "streaming"}>
          <Text testID="speech-flash-unsupported" class="text-sm text-muted">
            {t("web.audio.flashUnsupported")}
          </Text>
        </If>
        <If when={submitted()}>
          {(sent) => (
            <View testID="speech-request" class="min-w-0 gap-1">
              <Text class="text-xs text-muted">{t("web.media.speech.pending")}</Text>
              <Text class="text-xs text-muted">
                {[
                  t("web.media.speech.binding", {
                    account: sent().name,
                    connection: sent().request.connection,
                    model: sent().model,
                    revision: sent().request.revision,
                  }),
                  sent().request.voice,
                  sent().request.format,
                  sent().request.id,
                ].join(" · ")}
              </Text>
            </View>
          )}
        </If>
        <View class="flex-row flex-wrap gap-2">
          <Button
            testID="speech-generate"
            tone="primary"
            disabled={act.busy() || (!submitted() && (!status()?.speech || !voice() || !text().trim() || execution() === "streaming"))}
            onPress={() => void submit()}
          >
            {submitted() ? t("web.media.resubmit") : t("web.media.speech.submit")}
          </Button>
          <If when={submitted()}>
            <ConfirmButton
              testid="speech-new"
              label={t("web.media.speech.new")}
              question={t("web.media.newAsk")}
              disabled={act.busy()}
              onConfirm={() => {
                submitted.set(undefined);
                error.set(undefined);
              }}
            />
          </If>
        </View>
        <Refusal error={error()} testid="speech-error" />
      </Card>
      <Text class="text-base font-semibold text-ink">{t("web.media.speech.history")}</Text>
      <If when={jobs().length > 0} else={<Quiet>{t("web.media.speech.empty")}</Quiet>}>
        <Each of={jobs()} key={(job) => job.id}>
          {(job) => <SpeechJobCard job={job()} />}
        </Each>
      </If>
    </View>
  );
}

function SpeechJobCard(props: { job: MediaSpeechJob }) {
  const core = useCore();
  const channel = signal("");
  const posted = signal(false);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));

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
    <Card title={props.job.phaseText}>
      <View testID="speech-job" class="min-w-0 gap-3">
        <Text testID="speech-format-result" class="text-xs text-muted">
          {[props.job.model, props.job.connection, props.job.revision, props.job.voice, props.job.format, props.job.id].join(" · ")}
        </Text>
        <SourceLine source={props.job.source} testid="speech-source" />
        <AudioMetadataLine metadata={props.job.metadata} testid="speech-metadata" />
        <AudioUsageLine usage={props.job.usage} testid="speech-usage" />
        <If when={props.job.canRelease}>
          <ReleaseAssets id={props.job.id} />
        </If>
        <Text class="text-sm text-ink">{props.job.prompt}</Text>
        <If when={props.job.problem}>
          {(problem) => (
            <Text testID="speech-problem" class="text-sm text-muted">
              {problem()}
            </Text>
          )}
        </If>
        <ResultAudio
          attachment={props.job.attachment?.id}
          input={props.job.resultInput?.id}
          pcm={props.job.format === "pcm"}
          prefix="speech"
          save={t("web.media.speech.save")}
        />
        <If when={props.job.attachment}>
          {(file) => (
            <>
              <Field label={t("web.media.channel")}>
                <Select
                  label={t("web.media.channel")}
                  testid="speech-channel"
                  disabled={act.busy()}
                  placeholder={t("web.media.chooseChannel")}
                  value={channel()}
                  onChange={(v) => {
                    channel.set(v);
                    posted.set(false);
                  }}
                  options={(core()?.chat?.channels ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
                />
              </Field>
              <View class="flex-row">
                <Button testID="speech-publish" disabled={act.busy() || !channel() || posted()} onPress={() => void publish(file().id)}>
                  {posted() ? t("web.media.published") : t("web.media.speech.publish")}
                </Button>
              </View>
            </>
          )}
        </If>
        <JobActions job={props.job} act={act} prefix="speech">
          <If when={props.job.canResume === true}>
            <Button
              testID="speech-resume"
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
