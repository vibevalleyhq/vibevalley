// Ported from VibeValley apps/web/src/features/media/SpeechPanel.tsx.
import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { MediaAudioFormatValues, type MediaAudioFormat, type MediaSpeechJob, type MediaSpeechRequest, type ProviderVoiceRequest } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { api, reasonOf } from "../../infra/api";
import { openAttachment, playAudio, useAttachmentFile } from "../../infra/attachmentFile";
import { useCore } from "../../infra/frame";
import { defineQuery, providerQuery, ready, useQuery } from "../../infra/query";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { Field, Select, TextArea } from "../../ui/Field";
import { Card, Quiet } from "../../ui/layout";
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
  const execution = signal<"synchronous" | "asynchronous">("synchronous");
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
    if (!configuration || !binding || !chosen || !text().trim()) return;
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
          <Field label={t("web.media.speech.format")}>
            <Select
              label={t("web.media.speech.format")}
              testid="speech-format"
              disabled={act.busy() || submitted() !== undefined}
              value={format()}
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
              ]}
            />
          </Field>
          <Field label={t("web.media.speech.text")}>
            <TextArea
              testID="speech-text"
              accessibilityLabel={t("web.media.speech.text")}
              rows={4}
              value={text()}
              onInput={(e) => text.set(e.currentTarget.value)}
            />
          </Field>
        </View>
        <View class="flex-row flex-wrap gap-2">
          <Button
            testID="speech-generate"
            tone="primary"
            disabled={act.busy() || (!submitted() && (!status()?.speech || !voice() || !text().trim()))}
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
        <If when={error()}>
          {(why) => (
            <Text role="alert" testID="speech-error" class="text-sm text-berry">
              {why()}
            </Text>
          )}
        </If>
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
  const attId = () => props.job.attachment?.id ?? "";
  const disk = useAttachmentFile(attId);

  const publish = (attachment: string) => {
    const id = channel();
    const job = props.job.id;
    const text = props.job.text;
    return act.run(async () => {
      const sendKey = await publicationKey(job, id);
      await api.channel.message.send({ id, text, attachments: [attachment], sendKey });
      posted.set(true);
    });
  };

  return (
    <Card title={props.job.phaseText}>
      <View testID="speech-job" class="min-w-0 gap-2">
        <Text class="text-xs text-muted">{`${props.job.model} · ${props.job.voice} · ${props.job.format}`}</Text>
        <Text class="text-sm text-ink">{props.job.text}</Text>
        <If when={props.job.attachment}>
          {(file) => (
            <View class="gap-2">
              <View class="flex-row gap-2">
                <If when={disk()?.path}>
                  {(path) => (
                    <Button icon="play" onPress={() => void playAudio(path())}>
                      {t("web.library.kind.audio")}
                    </Button>
                  )}
                </If>
                <Button testID="speech-save" onPress={() => void openAttachment(file().id)}>
                  {t("web.media.save")}
                </Button>
              </View>
              <Field label={t("web.media.channel")}>
                <Select
                  label={t("web.media.channel")}
                  testid="speech-channel"
                  value={channel()}
                  onChange={(v) => {
                    channel.set(v);
                    posted.set(false);
                  }}
                  options={(core()?.chat?.channels ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
                />
              </Field>
              <Button disabled={act.busy() || !channel() || posted()} onPress={() => void publish(file().id)}>
                {posted() ? t("web.media.published") : t("web.media.publish")}
              </Button>
            </View>
          )}
        </If>
        <If when={props.job.canRelease}>
          <ReleaseAssets id={props.job.id} />
        </If>
        <If when={error()}>{(why) => <Text class="text-sm text-berry">{why()}</Text>}</If>
      </View>
    </Card>
  );
}
