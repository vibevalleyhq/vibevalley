// Ported from VibeValley apps/web/src/features/media/ImagePanel.tsx: image
// generation form and recent image jobs.
import { Image, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { MediaImageJob, MediaImageRequest } from "@vibevalley/protocol";

import { api } from "../../infra/api";
import { openAttachment, useAttachmentUrl } from "../../infra/attachmentFile";
import { useCore } from "../../infra/frame";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { Field, Select, TextArea, TextInput } from "../../ui/Field";
import { Card, Quiet } from "../../ui/layout";
import { Readiness } from "../setting";
import { publicationKey } from "./publication";
import { ReleaseAssets } from "./ReleaseAssets";

export function ImagePanel() {
  const state = useCore();
  const images = () => state()?.media?.filter((job): job is MediaImageJob => job.kind === "image") ?? [];
  const prompt = signal("");
  const format = signal<"text" | "layout">("text");
  const width = signal(1024);
  const height = signal(1024);
  const enhance = signal(false);
  const watermark = signal(true);
  const submitted = signal<MediaImageRequest | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));

  const submit = () => {
    const input: MediaImageRequest = submitted() ?? {
      id: crypto.randomUUID(),
      prompt: prompt(),
      format: format(),
      width: width(),
      height: height(),
      enhance: enhance(),
      watermark: watermark(),
    };
    submitted.set(input);
    return act.run(() => api.media.image.create(input));
  };

  return (
    <View testID="image-panel" class="max-w-3xl min-w-0 gap-4">
      <Readiness features={["image"]} />
      <Card title={t("web.media.generate")}>
        <Text class="text-sm text-muted">{t("web.media.notice")}</Text>
        <View class="min-w-0 gap-3">
          <Field label={t("web.media.format")}>
            <Select
              label={t("web.media.format")}
              testid="media-format"
              value={format()}
              onChange={(v) => format.set(v)}
              options={[
                { value: "text", label: t("web.media.text") },
                { value: "layout", label: t("web.media.layout") },
              ]}
            />
          </Field>
          <Field label={t("web.media.prompt")}>
            <TextArea
              testID="media-prompt"
              accessibilityLabel={t("web.media.prompt")}
              rows={4}
              value={prompt()}
              onInput={(e) => prompt.set(e.currentTarget.value)}
            />
          </Field>
          <View class="grid grid-cols-2 gap-3">
            <Field label={t("web.media.width")}>
              <TextInput
                testID="media-width"
                accessibilityLabel={t("web.media.width")}
                value={String(width())}
                onInput={(e) => width.set(Number(e.currentTarget.value) || 1024)}
              />
            </Field>
            <Field label={t("web.media.height")}>
              <TextInput
                testID="media-height"
                accessibilityLabel={t("web.media.height")}
                value={String(height())}
                onInput={(e) => height.set(Number(e.currentTarget.value) || 1024)}
              />
            </Field>
          </View>
          <View class="flex-row items-center gap-4">
            <View class="flex-row items-center gap-2">
              <Checkbox label={t("web.media.enhance")} checked={enhance()} onChange={(v) => enhance.set(v)} />
              <Text class="text-sm text-ink">{t("web.media.enhance")}</Text>
            </View>
            <View class="flex-row items-center gap-2">
              <Checkbox label={t("web.media.watermark")} checked={watermark()} onChange={(v) => watermark.set(v)} />
              <Text class="text-sm text-ink">{t("web.media.watermark")}</Text>
            </View>
          </View>
        </View>
        <If when={submitted()}>
          <Text class="text-xs text-muted">{t("web.media.pending")}</Text>
        </If>
        <View class="flex-row flex-wrap gap-2">
          <Button testID="media-generate" tone="primary" disabled={act.busy() || !prompt().trim()} onPress={() => void submit()}>
            {submitted() ? t("web.media.resubmit") : t("web.media.generate")}
          </Button>
          <If when={submitted()}>
            <ConfirmButton
              testid="media-new"
              tone="primary"
              label={t("web.media.new")}
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
            <Text role="alert" testID="media-error" class="text-sm text-berry">
              {why()}
            </Text>
          )}
        </If>
      </Card>
      <Text class="text-base font-semibold text-ink">{t("web.media.history")}</Text>
      <If when={images().length > 0} else={<Quiet>{t("web.media.empty")}</Quiet>}>
        <Each of={images()} key={(job) => job.id}>
          {(job) => <JobCard job={job()} />}
        </Each>
      </If>
    </View>
  );
}

function JobCard(props: { job: MediaImageJob }) {
  const state = useCore();
  const error = signal<string | undefined>(undefined);
  const channel = signal("");
  const posted = signal(false);
  const act = createAct((e) => error.set(e));
  const attId = () => props.job.attachment?.id ?? "";
  const url = useAttachmentUrl(attId);

  const publish = (attachment: string) => {
    const id = channel();
    const text = props.job.prompt;
    const job = props.job.id;
    return act.run(async () => {
      const sendKey = await publicationKey(job, id);
      await api.channel.message.send({ id, text, attachments: [attachment], sendKey });
      posted.set(true);
    });
  };

  return (
    <Card title={props.job.phaseText}>
      <View testID="media-job" class="min-w-0 gap-3">
        <Text class="text-xs text-muted">{`${props.job.model} · ${props.job.id}`}</Text>
        <Text class="text-sm text-ink">{props.job.prompt}</Text>
        <If when={props.job.problem}>{(prob) => <Text class="text-sm text-muted">{prob()}</Text>}</If>
        <If when={props.job.attachment}>
          {(file) => (
            <>
              <If when={url()}>{(src) => <Image testID="media-image" src={src()} style={{ width: 280, height: 220, objectFit: "contain" }} />}</If>
              <Button testID="media-save" onPress={() => void openAttachment(file().id)}>
                {t("web.media.save")}
              </Button>
              <Field label={t("web.media.channel")}>
                <Select
                  label={t("web.media.channel")}
                  testid="media-channel"
                  disabled={act.busy()}
                  placeholder={t("web.media.chooseChannel")}
                  value={channel()}
                  onChange={(value) => {
                    channel.set(value);
                    posted.set(false);
                  }}
                  options={(state()?.chat?.channels ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
                />
              </Field>
              <Button testID="media-publish" disabled={act.busy() || !channel() || posted()} onPress={() => void publish(file().id)}>
                {posted() ? t("web.media.published") : t("web.media.publish")}
              </Button>
            </>
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
