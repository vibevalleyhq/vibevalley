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
import { Icon } from "../../ui/Icon";
import { Card, Quiet } from "../../ui/layout";
import { Readiness } from "../setting";
import { FactGrid, FactRow, JobActions, NoticeBanner, PhasePill, Refusal, SectionHeading, SourceLine } from "./JobFacts";
import { publicationKey } from "./publication";

// The browser's number inputs took nothing else; a text input takes what these let through.
const digits = (typed: string) => typed.replace(/\D/gu, "");
const decimal = (typed: string) => typed.replace(/[^\d.]/gu, "").replace(/(\..*)\./gu, "$1");

const sizePresets: readonly { readonly ratio: string; readonly width: number; readonly height: number }[] = [
  { ratio: "1:1", width: 1024, height: 1024 },
  { ratio: "4:3", width: 1152, height: 864 },
  { ratio: "16:9", width: 1280, height: 720 },
  { ratio: "3:4", width: 864, height: 1152 },
];

export function ImagePanel() {
  const state = useCore();
  const images = () => state()?.media?.filter((job): job is MediaImageJob => job.kind === "image") ?? [];
  const prompt = signal("");
  const format = signal<"text" | "layout">("text");
  const width = signal(1024);
  const height = signal(1024);
  const enhance = signal(false);
  const watermark = signal(true);
  const advanced = signal(false);
  const seed = signal("");
  const steps = signal("");
  const guidance = signal("");
  const negative = signal("");
  const submitted = signal<MediaImageRequest | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const hasAdvanced = () => Boolean(seed() || steps() || guidance() || negative().trim());

  const submit = () => {
    const input: MediaImageRequest = submitted() ?? {
      id: crypto.randomUUID(),
      prompt: prompt(),
      format: format(),
      width: width(),
      height: height(),
      enhance: enhance(),
      watermark: watermark(),
      ...(seed() !== "" ? { seed: Number(seed()) } : {}),
      ...(steps() !== "" ? { steps: Number(steps()) } : {}),
      ...(guidance() !== "" ? { guidance: Number(guidance()) } : {}),
      ...(negative() !== "" ? { negativePrompt: negative() } : {}),
    };
    submitted.set(input);
    return act.run(() => api.media.image.create(input));
  };

  return (
    <View testID="image-panel" class="max-w-3xl min-w-0 gap-4">
      <Readiness features={["image"]} />
      <Card title={t("web.media.generate")}>
        <NoticeBanner tone="info">{t("web.media.notice")}</NoticeBanner>
        <View class="min-w-0 gap-3.5">
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
            <TextArea testID="media-prompt" accessibilityLabel={t("web.media.prompt")} rows={4} value={prompt()} onInput={(v) => prompt.set(v)} />
          </Field>
          <View class="min-w-0 gap-2">
            <View class="flex-row flex-wrap items-center gap-1.5">
              <Each of={sizePresets}>
                {(preset) => {
                  const active = () => width() === preset().width && height() === preset().height;
                  return (
                    <View
                      role="button"
                      accessibilityState={{ selected: active() }}
                      onPress={() => {
                        width.set(preset().width);
                        height.set(preset().height);
                      }}
                      class={`h-6 flex-row items-center gap-1 rounded-sm border px-2 transition duration-120 ease-out active:translate-y-px ${
                        active() ? "border-accent bg-ok-soft" : "border-line bg-page hover:bg-hover"
                      }`}
                    >
                      <Text class={`font-mono text-2xs font-medium tabular-nums ${active() ? "text-ok-ink" : "text-ink"}`}>{preset().ratio}</Text>
                      <Text class={`font-mono text-2xs tabular-nums ${active() ? "text-ok-ink" : "text-faint"}`}>{`${preset().width}×${preset().height}`}</Text>
                    </View>
                  );
                }}
              </Each>
            </View>
            <View class="flex-row gap-3">
              <View class="min-w-0 flex-1">
                <Field label={t("web.media.width")}>
                  <TextInput
                    testID="media-width"
                    accessibilityLabel={t("web.media.width")}
                    class="font-mono tabular-nums"
                    value={String(width())}
                    onInput={(v) => width.set(Number(v) || 1024)}
                  />
                </Field>
              </View>
              <View class="min-w-0 flex-1">
                <Field label={t("web.media.height")}>
                  <TextInput
                    testID="media-height"
                    accessibilityLabel={t("web.media.height")}
                    class="font-mono tabular-nums"
                    value={String(height())}
                    onInput={(v) => height.set(Number(v) || 1024)}
                  />
                </Field>
              </View>
            </View>
          </View>
          <View class="flex-row flex-wrap items-center gap-x-5 gap-y-2">
            <View class="flex-row items-center gap-2 py-0.5">
              <Checkbox label={t("web.media.enhance")} checked={enhance()} onChange={(v) => enhance.set(v)} />
              <View role="button" onPress={() => enhance.set(!enhance())}>
                <Text class="text-sm text-ink">{t("web.media.enhance")}</Text>
              </View>
            </View>
            <View class="flex-row items-center gap-2 py-0.5">
              <Checkbox label={t("web.media.watermark")} checked={watermark()} onChange={(v) => watermark.set(v)} />
              <View role="button" onPress={() => watermark.set(!watermark())}>
                <Text class="text-sm text-ink">{t("web.media.watermark")}</Text>
              </View>
            </View>
          </View>
        </View>
        <View class="min-w-0 gap-2.5">
          <View
            role="button"
            testID="media-advanced"
            accessibilityState={{ expanded: advanced() }}
            onPress={() => advanced.set(!advanced())}
            class="h-7 flex-row items-center gap-1.5 self-start rounded-md px-2 transition duration-120 ease-out hover:bg-hover"
          >
            <View
              class="h-3.5 w-3.5 shrink-0 items-center justify-center transition-transform duration-120 ease-out"
              style={{ transform: [{ rotate: advanced() ? "90deg" : "0deg" }] }}
            >
              <Icon name="expand" size={10} tone="muted" />
            </View>
            <Text class="text-xs font-medium text-muted">{t("web.media.advanced")}</Text>
            <If when={hasAdvanced()}>
              <View class="size-1.5 rounded-full bg-accent" />
            </If>
          </View>
          <If when={advanced()}>
            <View class="min-w-0 gap-3 rounded-md bg-side p-3">
              <View class="flex-row gap-3">
                <View class="min-w-0 flex-1">
                  <Field label={t("web.media.seed")}>
                    <TextInput
                      testID="media-seed"
                      accessibilityLabel={t("web.media.seed")}
                      class="font-mono tabular-nums"
                      value={seed()}
                      onInput={(v) => seed.set(digits(v))}
                    />
                  </Field>
                </View>
                <View class="min-w-0 flex-1">
                  <Field label={t("web.media.steps")}>
                    <TextInput
                      testID="media-steps"
                      accessibilityLabel={t("web.media.steps")}
                      class="font-mono tabular-nums"
                      value={steps()}
                      onInput={(v) => steps.set(digits(v))}
                    />
                  </Field>
                </View>
                <View class="min-w-0 flex-1">
                  <Field label={t("web.media.guidance")}>
                    <TextInput
                      testID="media-guidance"
                      accessibilityLabel={t("web.media.guidance")}
                      class="font-mono tabular-nums"
                      value={guidance()}
                      onInput={(v) => guidance.set(decimal(v))}
                    />
                  </Field>
                </View>
              </View>
              <Field label={t("web.media.negative")}>
                <TextArea testID="media-negative" accessibilityLabel={t("web.media.negative")} rows={2} value={negative()} onInput={(v) => negative.set(v)} />
              </Field>
            </View>
          </If>
        </View>
        <If when={submitted()}>
          <NoticeBanner tone="warn">{t("web.media.pending")}</NoticeBanner>
        </If>
        <View class="flex-row flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button testID="media-generate" tone="primary" icon="generate" disabled={act.busy() || !prompt().trim()} onPress={() => void submit()}>
            {submitted() ? t("web.media.resubmit") : t("web.media.generate")}
          </Button>
          <If when={submitted()}>
            <ConfirmButton
              testid="media-new"
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
        <Refusal error={error()} testid="media-error" />
      </Card>
      <SectionHeading title={t("web.media.history")} count={images().length} />
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
  const failed = () => props.job.phase === "failed" || props.job.phase === "download_failed";

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
    <Card title={props.job.model} action={<PhasePill phase={props.job.phase} text={props.job.phaseText} />}>
      <View testID="media-job" class="min-w-0 gap-3">
        <FactGrid>
          <FactRow label="ID">{props.job.id}</FactRow>
          <SourceLine source={props.job.source} testid="media-source" />
          <Text testID="media-usage" class="font-mono text-2xs text-muted tabular-nums">
            {props.job.usage ? t("web.media.usage", props.job.usage) : t("web.media.usageUnknown")}
          </Text>
        </FactGrid>
        <Text class="text-sm leading-relaxed text-ink">{props.job.prompt}</Text>
        <If when={props.job.problem}>{(prob) => <NoticeBanner tone={failed() ? "error" : "warn"}>{prob()}</NoticeBanner>}</If>
        <If when={props.job.attachment}>
          {(file) => (
            <View class="min-w-0 gap-3">
              <If when={url()}>
                {(src) => (
                  <View class="self-start overflow-hidden rounded-md border border-line bg-side">
                    <Image testID="media-image" src={src()} style={{ width: 280, height: 220, objectFit: "contain" }} />
                  </View>
                )}
              </If>
              <View class="flex-row flex-wrap items-center gap-2">
                <Button testID="media-save" icon="download" onPress={() => void openAttachment(file().id)}>
                  {t("web.media.save")}
                </Button>
                <Select
                  label={t("web.media.channel")}
                  testid="media-channel"
                  size="control"
                  class="w-44"
                  disabled={act.busy()}
                  placeholder={t("web.media.chooseChannel")}
                  value={channel()}
                  onChange={(value) => {
                    channel.set(value);
                    posted.set(false);
                  }}
                  options={(state()?.chat?.channels ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
                />
                <Button testID="media-publish" icon="send" disabled={act.busy() || !channel() || posted()} onPress={() => void publish(file().id)}>
                  {posted() ? t("web.media.published") : t("web.media.publish")}
                </Button>
              </View>
            </View>
          )}
        </If>
        <JobActions job={props.job} act={act} prefix="media" />
        <Refusal error={error()} />
      </View>
    </Card>
  );
}
