import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ProviderConnectionUpdate, ProviderModelListing, ProviderStatus, ProviderUpdate } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { api, reasonOf } from "#/infra/api.ts";
import { providerQuery, ready, settingsQuery, useQuery, useQueryClient } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { Field, Select, TextInput } from "#/ui/Field.tsx";
import { OutLink } from "#/ui/IconButton.tsx";
import { KeyField, SaveBar } from "#/ui/KeyField.tsx";
import { Card, Quiet, SecretInput } from "#/ui/layout.tsx";
import { SettingsPage } from "#/ui/settings.tsx";

const editable = (status: ProviderStatus): ProviderUpdate => ({
  revision: status.revision,
  connections: status.connections.map(({ key: _key, ...connection }) => connection),
  dictation: status.dictation,
  image: status.image,
  understanding: status.understanding,
  speech: status.speech,
  live: status.live,
});

export function ProviderPage() {
  const query = useQuery(providerQuery);
  return (
    <SettingsPage title={t("web.provider.title")} hint={t("web.provider.intro")}>
      <Show when={ready(query, undefined)} fallback={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.base.form.asking")}</Quiet>}>
        {(status) => <ProviderForm initial={untrack(status)} />}
      </Show>
    </SettingsPage>
  );
}

function ProviderForm(props: { initial: ProviderStatus }) {
  const start = untrack(() => props.initial);
  const [base, setBase] = createSignal(start);
  const [draft, setDraft] = createSignal(editable(start));
  const [listing, setListing] = createSignal<ProviderModelListing>();
  const [error, setError] = createSignal<string>();
  const client = useQueryClient();
  const act = createAct(setError);
  const dirty = () => !same(draft(), editable(base()));
  const accept = (status: ProviderStatus) => {
    setBase(status);
    setDraft(editable(status));
    setListing(undefined);
    setError(undefined);
    client.setData(providerQuery(), () => ({ value: status }));
  };
  const change = (id: string, patch: Partial<ProviderConnectionUpdate>) => {
    setDraft((current) => ({
      ...current,
      connections: current.connections.map((connection) => {
        if (connection.id !== id) return connection;
        const { key, ...rest } = { ...connection, ...patch };
        return key === undefined ? rest : { ...rest, key };
      }),
    }));
    setError(undefined);
  };
  const keepKey = (id: string) =>
    setDraft((current) => ({
      ...current,
      connections: current.connections.map((connection) => {
        if (connection.id !== id) return connection;
        const { key: _key, ...rest } = connection;
        return rest;
      }),
    }));
  const save = () => {
    const input = draft();
    return act.run(async () => {
      accept(await api.provider.update(input));
      await client.invalidate({ key: settingsQuery().key });
    });
  };
  const reload = () => act.run(async () => accept(await api.provider.get()));
  const discover = (connection: string) => {
    const revision = base().revision;
    setListing(undefined);
    setError(undefined);
    return act.run(async () => setListing(await api.provider.model.list({ connection, revision })));
  };
  const choices = () => draft().connections.map((connection) => ({ value: connection.id, label: connection.name || "MOSS" }));
  return (
    <fieldset
      disabled={act.busy()}
      aria-label={t("web.provider.title")}
      class="flex max-w-3xl min-w-0 flex-col gap-4"
      data-testid="provider-form"
      data-revision={base().revision}
    >
      <div class="flex flex-wrap items-center gap-2">
        <Button
          data-testid="provider-add"
          disabled={act.busy() || draft().connections.length >= 32}
          onClick={() => {
            setDraft((current) => ({
              ...current,
              connections: [...current.connections, { id: crypto.randomUUID(), name: "MOSS", adapter: "moss", enabled: true }],
            }));
          }}
        >
          {t("web.provider.add")}
        </Button>
        <ConfirmButton
          testid="provider-reload"
          label={t("web.provider.reload")}
          question={t("web.provider.reloadAsk")}
          disabled={act.busy()}
          onConfirm={() => void reload()}
        />
        <OutLink href="https://platform.moss.cn/" label={t("web.provider.console")} />
      </div>
      <Show when={draft().connections.length === 0}>
        <Quiet>{t("web.provider.empty")}</Quiet>
      </Show>
      <For each={draft().connections} keyed={(connection) => connection.id}>
        {(connection) => (
          <Card
            title="MOSS"
            class="min-w-0"
            action={
              <ConfirmButton
                testid="provider-delete"
                label={t("web.provider.remove")}
                question={t("web.provider.removeAsk")}
                disabled={act.busy()}
                onConfirm={() => {
                  const id = connection().id;
                  setDraft((current) => ({ ...current, connections: current.connections.filter((item) => item.id !== id) }));
                }}
              />
            }
          >
            <div class="flex min-w-0 flex-col gap-3" data-testid="provider-connection" data-id={connection().id}>
              <Field label={t("web.provider.name")}>
                <TextInput
                  data-testid="provider-name"
                  aria-label={t("web.provider.name")}
                  disabled={act.busy()}
                  value={connection().name}
                  onInput={(event) => change(connection().id, { name: event.currentTarget.value })}
                />
              </Field>
              <div class="flex items-center gap-2">
                <Checkbox
                  testid="provider-enabled"
                  label={t("web.provider.enabled")}
                  checked={connection().enabled}
                  disabled={act.busy()}
                  onChange={(enabled) => change(connection().id, { enabled })}
                />
                <span class="text-sm">{t("web.provider.enabled")}</span>
              </div>
              <div data-testid="provider-key">
                <KeyField
                  label="API Key"
                  status={base().connections.find((item) => item.id === connection().id)?.key ?? { source: null }}
                  removing={connection().key === null}
                  onRemove={(remove) => (remove ? change(connection().id, { key: null }) : keepKey(connection().id))}
                >
                  <SecretInput
                    data-testid="secret"
                    aria-label="MOSS API Key"
                    disabled={act.busy() || connection().key === null}
                    value={connection().key ?? ""}
                    placeholder={t("web.base.form.keepEmpty")}
                    onInput={(event) => (event.currentTarget.value ? change(connection().id, { key: event.currentTarget.value }) : keepKey(connection().id))}
                  />
                </KeyField>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button data-testid="provider-models" disabled={act.busy() || dirty()} onClick={() => void discover(connection().id)}>
                  {t("web.provider.discover")}
                </Button>
                <span class="text-xs text-muted">{dirty() ? t("web.provider.saveFirst") : t("web.provider.discoveryHint")}</span>
              </div>
              <Show when={!dirty() && listing()?.revision === base().revision && listing()?.connection === connection().id ? listing() : undefined}>
                {(result) => (
                  <div data-testid="provider-model-list" class="max-h-48 overflow-y-auto text-sm">
                    <Show when={result().models.length > 0} fallback={<Quiet>{t("web.provider.noModels")}</Quiet>}>
                      <ul class="flex flex-col gap-1">
                        <For each={result().models}>{(model) => <li class="font-mono break-all">{model.id}</li>}</For>
                      </ul>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </Card>
        )}
      </For>
      <Card title={t("web.provider.bindings")}>
        <Field label={t("web.provider.dictation")}>
          <Select
            label={t("web.provider.dictation")}
            testid="provider-dictation"
            placeholder={t("web.provider.unbound")}
            disabled={act.busy()}
            value={draft().dictation?.connection ?? ""}
            options={choices()}
            onChange={(connection) =>
              setDraft((current) => ({
                ...current,
                dictation: connection ? { connection, model: current.dictation?.model ?? base().dictationModels[0] ?? "" } : null,
              }))
            }
          />
        </Field>
        <Show when={draft().dictation}>
          <Field label={t("web.provider.model")} hint={t("web.provider.modelHint")}>
            <Select
              label={t("web.provider.model")}
              testid="provider-dictation-model"
              disabled={act.busy()}
              value={draft().dictation?.model ?? ""}
              options={base().dictationModels.map((model) => ({ value: model, label: model }))}
              onChange={(model) => setDraft((current) => ({ ...current, dictation: current.dictation ? { ...current.dictation, model } : null }))}
            />
          </Field>
        </Show>
        <Field label="MOSS Live" hint={t("web.provider.liveHint")}>
          <Select
            label="MOSS Live"
            testid="provider-live"
            placeholder={t("web.provider.unbound")}
            disabled={act.busy()}
            value={draft().live ?? ""}
            options={choices()}
            onChange={(live) => setDraft((current) => ({ ...current, live: live || null }))}
          />
        </Field>
        <p class="text-xs text-muted">{t("web.provider.bindingHint")}</p>
      </Card>
      <Card title={t("web.provider.imageSettings")}>
        <p class="text-xs text-muted" data-testid="provider-image-notice">
          {t("web.provider.imageNotice")}
        </p>
        <Field label={t("web.provider.imageConnection")}>
          <Select
            label={t("web.provider.imageConnection")}
            testid="provider-image"
            placeholder={t("web.provider.unbound")}
            disabled={act.busy()}
            value={draft().image?.connection ?? ""}
            options={choices()}
            onChange={(connection) =>
              setDraft((current) => ({
                ...current,
                image: connection ? { connection, model: current.image?.model ?? base().imageModels[0] ?? "" } : null,
              }))
            }
          />
        </Field>
        <Show when={draft().image}>
          <Field label={t("web.provider.imageModel")} hint={t("web.provider.imageModelHint")}>
            <Select
              label={t("web.provider.imageModel")}
              testid="provider-image-model"
              disabled={act.busy()}
              value={draft().image?.model ?? ""}
              options={base().imageModels.map((model) => ({ value: model, label: model }))}
              onChange={(model) => setDraft((current) => ({ ...current, image: current.image ? { ...current.image, model } : null }))}
            />
          </Field>
        </Show>
      </Card>
      <Card title={t("web.provider.understandingSettings")}>
        <p class="text-xs text-muted" data-testid="provider-understanding-notice">
          {t("web.provider.understandingNotice")}
        </p>
        <Field label={t("web.provider.understandingConnection")}>
          <Select
            label={t("web.provider.understandingConnection")}
            testid="provider-understanding"
            placeholder={t("web.provider.unbound")}
            disabled={act.busy()}
            value={draft().understanding?.connection ?? ""}
            options={choices()}
            onChange={(connection) =>
              setDraft((current) => ({
                ...current,
                understanding: connection ? { connection, model: current.understanding?.model ?? base().understandingModels[0] ?? "" } : null,
              }))
            }
          />
        </Field>
        <Show when={draft().understanding}>
          <Field label={t("web.provider.understandingModel")}>
            <Select
              label={t("web.provider.understandingModel")}
              testid="provider-understanding-model"
              disabled={act.busy()}
              value={draft().understanding?.model ?? ""}
              options={base().understandingModels.map((model) => ({ value: model, label: model }))}
              onChange={(model) => setDraft((current) => ({ ...current, understanding: current.understanding ? { ...current.understanding, model } : null }))}
            />
          </Field>
        </Show>
      </Card>
      <Card title={t("web.provider.speechSettings")}>
        <p class="text-xs text-muted" data-testid="provider-speech-notice">
          {t("web.provider.speechNotice")}
        </p>
        <Field label={t("web.provider.speechConnection")}>
          <Select
            label={t("web.provider.speechConnection")}
            testid="provider-speech"
            placeholder={t("web.provider.unbound")}
            disabled={act.busy()}
            value={draft().speech?.connection ?? ""}
            options={choices()}
            onChange={(connection) =>
              setDraft((current) => ({ ...current, speech: connection ? { connection, model: current.speech?.model ?? base().speechModels[0] ?? "" } : null }))
            }
          />
        </Field>
        <Show when={draft().speech}>
          <Field label={t("web.provider.speechModel")}>
            <Select
              label={t("web.provider.speechModel")}
              testid="provider-speech-model"
              disabled={act.busy()}
              value={draft().speech?.model ?? ""}
              options={base().speechModels.map((model) => ({ value: model, label: model }))}
              onChange={(model) => setDraft((current) => ({ ...current, speech: current.speech ? { ...current.speech, model } : null }))}
            />
          </Field>
        </Show>
      </Card>
      <SaveBar
        dirty={dirty()}
        busy={act.busy()}
        onSave={() => void save()}
        onUndo={() => accept(base())}
        left={
          <Show when={error()}>
            {(why) => (
              <p data-testid="provider-error" role="alert" class="text-berry">
                {why()}
              </p>
            )}
          </Show>
        }
      />
    </fieldset>
  );
}
