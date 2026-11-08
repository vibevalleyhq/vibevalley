import { createSignal, For, onCleanup, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ArtifactId, MediaInput, MediaUnderstandingJob, MediaUnderstandingRequest } from "@vibevalley/protocol";

import { api, reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { uploadMediaInput } from "#/infra/media.ts";
import { providerQuery, ready, useQuery } from "#/infra/query.ts";
import { Link } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { Field, TextArea, TextInput } from "#/ui/Field.tsx";
import { Card, Quiet } from "#/ui/layout.tsx";

interface Selected {
  file: File;
  input?: MediaInput;
}

export function UnderstandingPanel() {
  const core = useCore();
  const query = useQuery(providerQuery);
  const status = () => ready(query, undefined);
  const jobs = () => core()?.media?.filter((job) => job.kind === "understanding") ?? [];
  const [selected, setSelected] = createSignal<Selected[]>([]);
  const [prompt, setPrompt] = createSignal("");
  const [tokens, setTokens] = createSignal(512);
  const [consent, setConsent] = createSignal<{ connection: string; revision: number }>();
  const approved = () => {
    const current = status();
    const approval = consent();
    return (
      current !== undefined && approval !== undefined && current.revision === approval.revision && current.understanding?.connection === approval.connection
    );
  };
  const [submitted, setSubmitted] = createSignal<MediaUnderstandingRequest>();
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  let transfer: AbortController | undefined;
  onCleanup(() => transfer?.abort());
  const submit = () => {
    if (act.busy()) return;
    const configuration = status();
    const binding = configuration?.understanding;
    const approvedNow = approved();
    const files = selected();
    const text = prompt();
    const maxOutputTokens = tokens();
    const previous = submitted();
    const controller = new AbortController();
    transfer = controller;
    setError(undefined);
    return act
      .run(async () => {
        if (previous) return api.media.understanding.create(previous, { signal: controller.signal });
        if (!configuration || !binding || !approvedNow) return;
        const ids = await Promise.all(
          files.map(async (selected) => {
            const file = selected.file;
            const input =
              selected.input ??
              (await api.media.input.create(
                { kind: file.type.startsWith("image/") ? "image" : "video", name: file.name, mime: file.type, size: file.size },
                { signal: controller.signal },
              ));
            setSelected((items) => items.map((item) => (item.file === file ? { ...item, input } : item)));
            const uploaded = input.phase === "ready" ? input : await uploadMediaInput(input.id, file, controller.signal);
            setSelected((items) => items.map((item) => (item.file === file ? { ...item, input: uploaded } : item)));
            return uploaded.id;
          }),
        );
        const request: MediaUnderstandingRequest = {
          id: crypto.randomUUID(),
          prompt: text,
          inputs: ids,
          connection: binding.connection,
          revision: configuration.revision,
          allowUpload: true,
          maxOutputTokens,
        };
        setSubmitted(request);
        return api.media.understanding.create(request, { signal: controller.signal });
      })
      .finally(() => controller.abort());
  };
  return (
    <section class="flex min-w-0 flex-col gap-4" data-testid="understanding-panel" aria-label={t("web.media.understanding.title")}>
      <Card title={t("web.media.understanding.title")}>
        <p class="text-sm text-muted">{t("web.media.understanding.notice")}</p>
        <Show when={status()?.understanding} fallback={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.media.understanding.configure")}</Quiet>}>
          {(binding) => (
            <p class="text-xs break-all text-muted" data-testid="understanding-connection">
              {binding().connection} · {binding().model}
            </p>
          )}
        </Show>
        <fieldset disabled={act.busy() || submitted() !== undefined} class="flex min-w-0 flex-col gap-3" aria-label={t("web.media.understanding.title")}>
          <Field label={t("web.media.understanding.files")}>
            <TextInput
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,video/mp4,video/x-m4v,video/quicktime,video/x-msvideo,video/webm,video/x-matroska"
              data-testid="understanding-files"
              aria-label={t("web.media.understanding.files")}
              onChange={(event) => {
                setSelected(Array.from(event.currentTarget.files ?? [], (file) => ({ file })));
                setConsent(undefined);
              }}
            />
          </Field>
          <For each={selected()} keyed={(item) => item.file}>
            {(item) => (
              <p class="text-xs break-all text-muted">
                {item().file.name} · {item().input?.phase === "ready" ? t("web.media.understanding.stored") : t("web.media.understanding.selected")}
              </p>
            )}
          </For>
          <Field label={t("web.media.understanding.prompt")}>
            <TextArea
              data-testid="understanding-prompt"
              aria-label={t("web.media.understanding.prompt")}
              rows={3}
              maxlength={64000}
              value={prompt()}
              onInput={(event) => setPrompt(event.currentTarget.value)}
            />
          </Field>
          <Field label={t("web.media.understanding.tokens")}>
            <TextInput
              data-testid="understanding-tokens"
              aria-label={t("web.media.understanding.tokens")}
              type="number"
              min={1}
              max={8192}
              value={tokens()}
              onInput={(event) => setTokens(Number(event.currentTarget.value))}
            />
          </Field>
          <label class="flex items-start gap-2 text-sm">
            <Checkbox
              testid="understanding-consent"
              label={t("web.media.understanding.consent")}
              checked={approved()}
              onChange={(checked) => {
                const current = status();
                setConsent(checked && current?.understanding ? { connection: current.understanding.connection, revision: current.revision } : undefined);
              }}
            />
            {t("web.media.understanding.consent")}
          </label>
        </fieldset>
        <Show when={submitted()}>
          <p class="text-xs text-muted">{t("web.media.understanding.pending")}</p>
        </Show>
        <Show when={act.busy() && submitted() === undefined}>
          <p role="status" data-testid="understanding-uploading" class="text-sm text-muted">
            {t("web.media.understanding.uploading")}
          </p>
        </Show>
        <div class="flex flex-wrap gap-2">
          <Button
            data-testid="understanding-submit"
            tone="primary"
            disabled={
              act.busy() ||
              (submitted() === undefined && (!approved() || !status()?.understanding || !prompt().trim() || selected().length === 0 || selected().length > 5))
            }
            onClick={() => void submit()}
          >
            {submitted() ? t("web.media.resubmit") : t("web.media.understanding.submit")}
          </Button>
          <Show when={act.busy() && submitted() === undefined}>
            <Button data-testid="understanding-stop-upload" onClick={() => transfer?.abort()}>
              {t("web.media.understanding.stopUpload")}
            </Button>
          </Show>
          <Show when={submitted()}>
            <ConfirmButton
              testid="understanding-new"
              label={t("web.media.understanding.new")}
              question={t("web.media.understanding.newAsk")}
              disabled={act.busy()}
              onConfirm={() => {
                setSubmitted(undefined);
                setConsent(undefined);
                setError(undefined);
                void act.run(() => query.refetch());
              }}
            />
          </Show>
        </div>
        <Show when={error()}>
          {(why) => (
            <p role="alert" data-testid="understanding-error" class="text-sm text-berry">
              {why()}
            </p>
          )}
        </Show>
      </Card>
      <Show when={jobs().length > 0}>
        <h2 class="text-base font-semibold">{t("web.media.understanding.history")}</h2>
      </Show>
      <For each={jobs()} keyed={(job) => job.id}>
        {(job) => <UnderstandingCard job={job()} />}
      </For>
    </section>
  );
}

function UnderstandingCard(props: { job: MediaUnderstandingJob }) {
  const [error, setError] = createSignal<string>();
  const [saved, setSaved] = createSignal<ArtifactId>();
  const act = createAct(setError);
  const save = () => {
    const job = props.job;
    if (!job.result) return;
    const content = job.result.text;
    return act.run(async () => setSaved((await api.artifact.create({ title: job.prompt.slice(0, 80), kind: "markdown", content })).id));
  };
  return (
    <Card title={props.job.phaseText}>
      <div
        data-testid="understanding-job"
        data-id={props.job.id}
        data-phase={props.job.phase}
        data-cleanup={props.job.cleanup}
        class="flex min-w-0 flex-col gap-3"
      >
        <p class="text-xs break-all text-muted">
          {props.job.model} · {props.job.connection} · {props.job.id}
        </p>
        <p class="text-sm break-words whitespace-pre-wrap">{props.job.prompt}</p>
        <For each={props.job.inputs}>{(input) => <p class="text-xs break-all text-muted">{input.name}</p>}</For>
        <Show when={props.job.problem}>
          <p class="text-sm text-berry">{props.job.problem}</p>
        </Show>
        <p class="text-xs text-muted" data-testid="understanding-cleanup-status">
          {props.job.cleanupText}
        </p>
        <Show when={props.job.result} fallback={<Quiet>{t("web.media.usageUnknown")}</Quiet>}>
          {(result) => (
            <>
              <Show when={result().status === "incomplete"}>
                <p data-testid="understanding-truncated" class="text-sm text-berry">
                  {t("web.media.understanding.truncated")}
                </p>
              </Show>
              <p data-testid="understanding-result" class="text-sm break-words whitespace-pre-wrap">
                {result().text}
              </p>
              <p data-testid="understanding-usage" class="text-xs text-muted">
                {t("web.media.understanding.usage", {
                  input: result().usage.inputTokens,
                  output: result().usage.outputTokens,
                  total: result().usage.totalTokens,
                })}{" "}
                · {result().model}
              </p>
              <Show
                when={saved()}
                fallback={
                  <Button data-testid="understanding-save" disabled={act.busy()} onClick={() => void save()}>
                    {t("web.media.understanding.save")}
                  </Button>
                }
              >
                {(id) => (
                  <Link href={`/artifacts/${id()}`} class="text-sm text-water underline" data-testid="understanding-saved">
                    {t("web.media.understanding.open")}
                  </Link>
                )}
              </Show>
            </>
          )}
        </Show>
        <div class="flex flex-wrap gap-2">
          <Show when={props.job.canCancel}>
            <ConfirmButton
              testid="understanding-cancel"
              label={t("web.media.cancel")}
              question={t("web.media.cancelAsk")}
              disabled={act.busy()}
              onConfirm={() => {
                const id = props.job.id;
                void act.run(() => api.media.job.cancel({ id }));
              }}
            />
          </Show>
          <Show when={props.job.canCleanup}>
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
          </Show>
        </div>
        <Show when={error()}>
          {(why) => (
            <p role="alert" class="text-sm text-berry">
              {why()}
            </p>
          )}
        </Show>
      </div>
    </Card>
  );
}
