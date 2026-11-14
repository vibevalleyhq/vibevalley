// Ported from VibeValley apps/web/src/features/media/UnderstandingPanel.tsx.
import { cleanup, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ArtifactId, Attachment, MediaUnderstandingAuthorizationRequest, MediaUnderstandingJob, MediaUnderstandingRequest } from "@vibevalley/protocol";

import { api, reasonOf } from "../../infra/api";
import { useCore } from "../../infra/frame";
import { providerQuery, ready, useQuery } from "../../infra/query";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { Field, Select, TextArea, TextInput } from "../../ui/Field";
import { Card, Quiet } from "../../ui/layout";
import { TextLink } from "../../ui/TextLink";
import { JobActions, Refusal, SourceLine } from "./JobFacts";
import { publicationKey } from "./publication";

const maximumTokens = 8192;

/** Understanding one kept file (a library item): its bytes are taken as the input on submit, checked as an upload is. */
export function UnderstandingPanel(props: { file: Attachment }) {
  const core = useCore();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const jobs = () => {
    const file = props.file.id;
    return (core()?.media ?? []).filter((job): job is MediaUnderstandingJob => job.kind === "understanding" && job.inputs.some((input) => input.hash === file));
  };
  const prompt = signal("");
  const tokens = signal(512);
  const channel = signal("");
  const consent = signal<{ connection: string; revision: number } | undefined>(undefined);
  const approved = () => {
    const current = status();
    const approval = consent();
    return (
      current !== undefined && approval !== undefined && current.revision === approval.revision && current.understanding?.connection === approval.connection
    );
  };
  const submitted = signal<MediaUnderstandingRequest | MediaUnderstandingAuthorizationRequest | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  let transfer: AbortController | undefined;
  cleanup(() => transfer?.abort());
  const frozen = () => act.busy() || submitted() !== undefined;

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
    <View testID="understanding-panel" class="min-w-0 gap-4">
      <Card title={t("web.media.understanding.title")}>
        <Text class="text-sm text-muted">{t("web.media.understanding.notice")}</Text>
        <If when={status()?.understanding} else={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.media.understanding.configure")}</Quiet>}>
          {(binding) => (
            <Text testID="understanding-connection" class="text-xs text-muted">
              {`${binding().connection} · ${binding().model}`}
            </Text>
          )}
        </If>
        <View class="min-w-0 gap-3">
          <Text testID="understanding-file" class="text-xs text-muted">
            {props.file.name}
          </Text>
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
          <Field label={t("web.media.understanding.tokens")}>
            <TextInput
              testID="understanding-tokens"
              accessibilityLabel={t("web.media.understanding.tokens")}
              disabled={frozen()}
              value={String(tokens())}
              onInput={(v) => tokens.set(Math.min(maximumTokens, Math.max(1, Number(v.replace(/\D/gu, "")) || 1)))}
            />
          </Field>
          <Field label={t("web.media.understanding.executor")}>
            <Select
              label={t("web.media.understanding.executor")}
              placeholder={t("web.media.understanding.direct")}
              testid="understanding-channel"
              disabled={frozen()}
              value={channel()}
              onChange={(v) => channel.set(v)}
              options={(core()?.chat?.channels ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
            />
          </Field>
          <If when={channel()}>
            <Text class="text-sm text-muted">{t("web.media.understanding.authorizationNotice")}</Text>
          </If>
          <View class="flex-row items-start gap-2">
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
            <Text class="min-w-0 flex-1 text-sm text-ink">{t("web.media.understanding.consent")}</Text>
          </View>
        </View>
        <If when={submitted()}>
          <Text class="text-xs text-muted">{t("web.media.understanding.pending")}</Text>
        </If>
        <If when={act.busy() && submitted() === undefined}>
          <Text testID="understanding-uploading" class="text-sm text-muted">
            {t("web.media.understanding.uploading")}
          </Text>
        </If>
        <View class="flex-row flex-wrap gap-2">
          <Button
            testID="understanding-submit"
            tone="primary"
            disabled={act.busy() || (submitted() === undefined && (!approved() || !status()?.understanding || !prompt().trim()))}
            onPress={() => void submit()}
          >
            {submitted() ? t("web.media.resubmit") : channel() ? t("web.media.understanding.authorize") : t("web.media.understanding.submit")}
          </Button>
          <If when={act.busy() && submitted() === undefined}>
            <Button testID="understanding-stop-upload" onPress={() => transfer?.abort()}>
              {t("web.media.understanding.stopUpload")}
            </Button>
          </If>
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
        <Text class="text-base font-semibold text-ink">{t("web.media.understanding.history")}</Text>
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
  const sent = signal(false);
  const act = createAct((e) => error.set(e));
  const save = () => {
    const job = props.job;
    if (!job.result) return;
    const content = job.result.text;
    return act.run(async () => saved.set((await api.artifact.create({ title: job.prompt.slice(0, 80), kind: "markdown", content })).id));
  };
  return (
    <Card title={props.job.phaseText}>
      <View testID="understanding-job" class="min-w-0 gap-3">
        <Text class="text-xs text-muted">{`${props.job.model} · ${props.job.connection} · ${props.job.id}`}</Text>
        <Text class="text-sm text-ink">{props.job.prompt}</Text>
        <SourceLine source={props.job.source} testid="understanding-source" />
        <If when={props.job.phase === "authorized" ? props.job.authorization : undefined}>
          {(approval) => (
            <>
              <Text testID="understanding-authorization" class="text-sm text-muted">
                {t("web.media.understanding.authorization", { channel: approval().channel })}
              </Text>
              <View class="flex-row">
                <Button
                  testID="understanding-delegate"
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
            </>
          )}
        </If>
        <Each of={props.job.inputs}>{(input) => <Text class="text-xs text-muted">{input().name}</Text>}</Each>
        <If when={props.job.problem}>{(problem) => <Text class="text-sm text-berry">{problem()}</Text>}</If>
        <Text testID="understanding-cleanup-status" class="text-xs text-muted">
          {props.job.cleanupText}
        </Text>
        <If when={props.job.result} else={<Quiet>{t("web.media.usageUnknown")}</Quiet>}>
          {(result) => (
            <>
              <If when={result().status === "incomplete"}>
                <Text testID="understanding-truncated" class="text-sm text-berry">
                  {t("web.media.understanding.truncated")}
                </Text>
              </If>
              <Text testID="understanding-result" class="text-sm text-ink">
                {result().text}
              </Text>
              <Text testID="understanding-usage" class="text-xs text-muted">
                {`${t("web.media.understanding.usage", {
                  input: result().usage.inputTokens,
                  output: result().usage.outputTokens,
                  total: result().usage.totalTokens,
                })} · ${result().model}`}
              </Text>
              <If
                when={saved()}
                else={
                  <View class="flex-row">
                    <Button testID="understanding-save" disabled={act.busy()} onPress={() => void save()}>
                      {t("web.media.understanding.save")}
                    </Button>
                  </View>
                }
              >
                {(id) => (
                  <TextLink href={`/artifacts/${id()}`} testid="understanding-saved">
                    {t("web.media.understanding.open")}
                  </TextLink>
                )}
              </If>
            </>
          )}
        </If>
        <JobActions job={props.job} act={act} prefix="understanding">
          <If when={props.job.canCleanup}>
            <ConfirmButton
              testid="understanding-cleanup"
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
