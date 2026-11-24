import { cleanup, Clipboard, computed, Image, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ArtifactId, Attachment, MediaUnderstandingAuthorizationRequest, MediaUnderstandingJob, MediaUnderstandingRequest } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Checkbox } from "../../design/Checkbox";
import { ConfirmButton } from "../../design/ConfirmButton";
import { fileKind, kindIcon, sizeText } from "../../design/domain/AttachmentTile";
import { Field, Select, TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Card, Quiet } from "../../design/layout";
import { Dot } from "../../design/Tag";
import { TextLink } from "../../design/TextLink";
import { api, reasonOf } from "../../infra/api";
import { useAttachmentUrl } from "../../infra/attachmentFile";
import { useTimeout } from "../../infra/base/timer";
import { useCollabSlice, useOpsSlice } from "../../infra/frame";
import { providerQuery, ready, useQuery } from "../../infra/query";
import { FactGrid, JobActions, NoticeBanner, PhasePill, Refusal, SectionHeading, SourceLine } from "./JobFacts";
import { publicationKey } from "./publication";

const maximumTokens = 8192;

/** Understanding one kept file (a library item): its bytes are taken as the input on submit, checked as an upload is. */
export function UnderstandingPanel(props: { file: Attachment }) {
  const ops = useOpsSlice();
  const collab = useCollabSlice();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const thumbUrl = useAttachmentUrl(() => props.file.id);
  const kind = () => fileKind(props.file.type);
  const jobs = computed(() => {
    const file = props.file.id;
    return (ops()?.media ?? []).filter((job): job is MediaUnderstandingJob => job.kind === "understanding" && job.inputs.some((input) => input.hash === file));
  });
  const prompt = signal("");
  const tokens = signal(512);
  const channel = signal("");
  const consent = signal<{ connection: string; revision: number } | undefined>(undefined);
  const approved = computed(() => {
    const current = status();
    const approval = consent();
    return (
      current !== undefined && approval !== undefined && current.revision === approval.revision && current.understanding?.connection === approval.connection
    );
  });
  const submitted = signal<MediaUnderstandingRequest | MediaUnderstandingAuthorizationRequest | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  let transfer: AbortController | undefined;
  cleanup(() => transfer?.abort());
  const frozen = computed(() => act.busy() || submitted() !== undefined);

  const submit = () => {
    if (act.busy()) return;
    const configuration = status();
    const binding = configuration?.understanding;
    const approvedNow = approved();
    const file = props.file.id;
    const text = prompt();
    const maxOutputTokens = tokens();
    const target = channel();
    const previous = submitted();
    const controller = new AbortController();
    transfer = controller;
    error.set(undefined);
    return act
      .run(async () => {
        if (previous)
          return "channel" in previous
            ? api.media.understanding.authorize(previous, { signal: controller.signal })
            : api.media.understanding.create(previous, { signal: controller.signal });
        if (!configuration || !binding || !approvedNow) return;
        const input = await api.media.input.adopt({ attachment: file }, { signal: controller.signal });
        const request: MediaUnderstandingRequest = {
          id: crypto.randomUUID(),
          prompt: text,
          inputs: [input.id],
          connection: binding.connection,
          revision: configuration.revision,
          allowUpload: true,
          maxOutputTokens,
        };
        if (target) {
          const authorization: MediaUnderstandingAuthorizationRequest = { ...request, channel: target };
          submitted.set(authorization);
          return api.media.understanding.authorize(authorization, { signal: controller.signal });
        }
        submitted.set(request);
        return api.media.understanding.create(request, { signal: controller.signal });
      })
      .finally(() => controller.abort());
  };

  return (
    <View testID="understanding-panel" class="max-w-3xl min-w-0 gap-4">
      <Card title={t("web.media.understanding.title")}>
        <NoticeBanner tone="info">{t("web.media.understanding.notice")}</NoticeBanner>
        <If
          when={status()?.understanding}
          else={<NoticeBanner tone="warn">{query.error() ? reasonOf(query.error()) : t("web.media.understanding.configure")}</NoticeBanner>}
        >
          {(binding) => (
            <View class="flex-row items-center gap-2 rounded-md bg-side px-3 py-2">
              <Dot tone="leaf" size={6} ring={false} />
              <Text testID="understanding-connection" class="min-w-0 flex-1 truncate font-mono text-xs text-muted">
                {`${binding().connection} · ${binding().model}`}
              </Text>
            </View>
          )}
        </If>
        <View class="min-w-0 gap-3.5">
          <View class="flex-row items-center gap-3 rounded-md bg-side p-2.5">
            <View class="h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-line bg-page">
              <If when={kind() === "image" ? thumbUrl() : undefined} else={<Icon name={kindIcon[kind()]} size={20} tone="muted" />}>
                {(src) => <Image src={src()} class="h-11 w-11 object-cover" />}
              </If>
            </View>
            <View class="min-w-0 flex-1 gap-0.5">
              <Text testID="understanding-file" class="truncate text-sm font-medium text-ink">
                {props.file.name}
              </Text>
              <Text class="truncate font-mono text-2xs text-muted tabular-nums">{`${props.file.type} · ${sizeText(props.file.size)}`}</Text>
            </View>
          </View>
          <Field label={t("web.media.understanding.prompt")}>
            <TextArea
              testID="understanding-prompt"
              accessibilityLabel={t("web.media.understanding.prompt")}
              rows={3}
              disabled={frozen()}
              value={prompt()}
              onInput={(v) => prompt.set(v.slice(0, 64_000))}
            />
          </Field>
          <View class="flex-row gap-3">
            <View class="min-w-0 flex-1">
              <Field label={t("web.media.understanding.tokens")}>
                <TextInput
                  testID="understanding-tokens"
                  accessibilityLabel={t("web.media.understanding.tokens")}
                  class="font-mono tabular-nums"
                  disabled={frozen()}
                  value={String(tokens())}
                  onInput={(v) => {
                    const n = Number(v.replace(/\D/gu, ""));
                    tokens.set(Math.min(maximumTokens, Math.max(1, Number.isFinite(n) && n > 0 ? n : 1)));
                  }}
                />
              </Field>
            </View>
            <View class="min-w-0 flex-1">
              <Field label={t("web.media.understanding.executor")}>
                <Select
                  label={t("web.media.understanding.executor")}
                  placeholder={t("web.media.understanding.direct")}
                  testid="understanding-channel"
                  disabled={frozen()}
                  value={channel()}
                  onChange={(v) => channel.set(v)}
                  options={(collab()?.chat?.channels ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
                />
              </Field>
            </View>
          </View>
          <If when={channel()}>
            <NoticeBanner tone="info">{t("web.media.understanding.authorizationNotice")}</NoticeBanner>
          </If>
          <View class="flex-row items-start gap-2 rounded-md bg-side px-3 py-2.5">
            <Checkbox
              testid="understanding-consent"
              label={t("web.media.understanding.consent")}
              disabled={frozen()}
              checked={approved()}
              onChange={(checked) => {
                const current = status();
                consent.set(checked && current?.understanding ? { connection: current.understanding.connection, revision: current.revision } : undefined);
              }}
            />
            <Text class="min-w-0 flex-1 text-xs leading-relaxed text-ink">{t("web.media.understanding.consent")}</Text>
          </View>
        </View>
        <If when={submitted()}>
          <NoticeBanner tone="warn">{t("web.media.understanding.pending")}</NoticeBanner>
        </If>
        <If when={act.busy() && submitted() === undefined}>
          <View class="flex-row flex-wrap items-center justify-between gap-2 rounded-md bg-side px-3 py-2">
            <View class="flex-row items-center gap-2">
              <Dot tone="water" size={6} ring={false} />
              <Text testID="understanding-uploading" class="text-xs text-water">
                {t("web.media.understanding.uploading")}
              </Text>
            </View>
            <Button testID="understanding-stop-upload" tone="danger" icon="stop" onPress={() => transfer?.abort()}>
              {t("web.media.understanding.stopUpload")}
            </Button>
          </View>
        </If>
        <View class="flex-row flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button
            testID="understanding-submit"
            tone="primary"
            icon="understand"
            disabled={act.busy() || (submitted() === undefined && (!approved() || !status()?.understanding || !prompt().trim()))}
            onPress={() => void submit()}
          >
            {submitted() ? t("web.media.resubmit") : channel() ? t("web.media.understanding.authorize") : t("web.media.understanding.submit")}
          </Button>
          <If when={submitted()}>
            <ConfirmButton
              testid="understanding-new"
              label={t("web.media.understanding.new")}
              question={t("web.media.understanding.newAsk")}
              disabled={act.busy()}
              onConfirm={() => {
                submitted.set(undefined);
                consent.set(undefined);
                error.set(undefined);
                void act.run(() => query.refetch());
              }}
            />
          </If>
        </View>
        <Refusal error={error()} testid="understanding-error" />
      </Card>
      <If when={jobs().length > 0}>
        <SectionHeading title={t("web.media.understanding.history")} count={jobs().length} />
      </If>
      <Each of={jobs()} key={(job) => job.id}>
        {(job) => <UnderstandingCard job={job()} />}
      </Each>
    </View>
  );
}

function UnderstandingCard(props: { job: MediaUnderstandingJob }) {
  const error = signal<string | undefined>(undefined);
  const saved = signal<ArtifactId | undefined>(undefined);
  const copied = signal(false);
  const later = useTimeout();
  const sent = signal(false);
  const act = createAct((e) => error.set(e));
  const save = () => {
    const job = props.job;
    if (!job.result) return;
    const content = job.result.text;
    return act.run(async () => saved.set((await api.artifact.create({ title: job.prompt.slice(0, 80), artifactType: "docs", content })).id));
  };
  return (
    <Card title={props.job.model} action={<PhasePill phase={props.job.phase} text={props.job.phaseText} />}>
      <View testID="understanding-job" class="min-w-0 gap-3">
        <FactGrid>
          <Text class="font-mono text-2xs text-muted tabular-nums">{`${props.job.model} · ${props.job.connection} · ${props.job.id}`}</Text>
          <SourceLine source={props.job.source} testid="understanding-source" />
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Each of={props.job.inputs} key={(i) => i.hash}>
              {(input) => (
                <View class="rounded-xs bg-hover px-1.5 py-px">
                  <Text class="font-mono text-2xs text-muted">{input().name}</Text>
                </View>
              )}
            </Each>
          </View>
          <Text testID="understanding-cleanup-status" class="text-2xs text-faint">
            {props.job.cleanupText}
          </Text>
        </FactGrid>
        <Text class="text-sm font-medium text-ink">{props.job.prompt}</Text>
        <If when={props.job.phase === "authorized" ? props.job.authorization : undefined}>
          {(approval) => (
            <View class="min-w-0 gap-2 rounded-md bg-side p-3">
              <Text testID="understanding-authorization" class="text-xs text-muted">
                {t("web.media.understanding.authorization", { channel: approval().channel })}
              </Text>
              <View class="flex-row">
                <Button
                  testID="understanding-delegate"
                  icon="send"
                  disabled={act.busy() || sent()}
                  onPress={() => {
                    const id = props.job.id;
                    const channel = approval().channel;
                    void act.run(async () => {
                      await api.channel.message.send({
                        id: channel,
                        text: t("web.media.understanding.delegation", { id }),
                        sendKey: await publicationKey(`understanding:${id}`, channel),
                      });
                      sent.set(true);
                    });
                  }}
                >
                  {sent() ? t("web.media.understanding.delegated") : t("web.media.understanding.delegate")}
                </Button>
              </View>
            </View>
          )}
        </If>
        <If when={props.job.problem}>{(problem) => <NoticeBanner tone="error">{problem()}</NoticeBanner>}</If>
        <If when={props.job.result} else={<Quiet>{t("web.media.usageUnknown")}</Quiet>}>
          {(result) => (
            <View class="min-w-0 gap-2.5 rounded-md bg-side p-3">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-xs font-semibold text-ink">{t("web.library.understood")}</Text>
                <View class="flex-row items-center gap-1.5">
                  <IconButton
                    icon={copied() ? "check" : "copy"}
                    size={14}
                    label={copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")}
                    onClick={() =>
                      void Clipboard.writeText(result().text).then(() => {
                        copied.set(true);
                        later(() => copied.set(false), 1500);
                      })
                    }
                  />
                  <If
                    when={saved()}
                    else={
                      <Button testID="understanding-save" icon="artifacts" disabled={act.busy()} onPress={() => void save()}>
                        {t("web.media.understanding.save")}
                      </Button>
                    }
                  >
                    {(id) => (
                      <TextLink href={`/artifacts/${id()}`} testid="understanding-saved">
                        {t("web.media.understanding.open")}
                      </TextLink>
                    )}
                  </If>
                </View>
              </View>
              <If when={result().status === "incomplete"}>
                <NoticeBanner tone="warn" testid="understanding-truncated">
                  {t("web.media.understanding.truncated")}
                </NoticeBanner>
              </If>
              <Text testID="understanding-result" class="text-sm leading-relaxed text-ink select-text">
                {result().text}
              </Text>
              <Text testID="understanding-usage" class="border-t border-line pt-2 font-mono text-2xs text-muted tabular-nums">
                {`${t("web.media.understanding.usage", {
                  input: result().usage.inputTokens,
                  output: result().usage.outputTokens,
                  total: result().usage.totalTokens,
                })} · ${result().model}`}
              </Text>
            </View>
          )}
        </If>
        <JobActions job={props.job} act={act} prefix="understanding">
          <If when={props.job.canCleanup}>
            <ConfirmButton
              testid="understanding-cleanup"
              tone="danger"
              icon="delete"
              label={t("web.media.understanding.cleanup")}
              question={t("web.media.understanding.cleanupAsk")}
              disabled={act.busy()}
              onConfirm={() => {
                const id = props.job.id;
                void act.run(() => api.media.understanding.cleanup({ id }));
              }}
            />
          </If>
        </JobActions>
        <Refusal error={error()} />
      </View>
    </Card>
  );
}
