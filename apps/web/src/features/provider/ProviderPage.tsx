import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ProviderConnectionUpdate, ProviderModelListing, ProviderStatus, ProviderUpdate } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { api, reasonOf } from "#/infra/api.ts";
import { providerQuery, ready, settingsQuery, useQuery, useQueryClient } from "#/infra/query.ts";
import { Link } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { Field, Select, TextInput } from "#/ui/Field.tsx";
import { OutLink } from "#/ui/IconButton.tsx";
import { KeyField, SaveBar } from "#/ui/KeyField.tsx";
import { Card, Quiet, SecretInput } from "#/ui/layout.tsx";
import { SettingsPage } from "#/ui/settings.tsx";

const viewStyles = stylex.create({
  content: { display: "flex", maxWidth: "var(--container-3xl)", minWidth: 0, flexDirection: "column", gap: "calc(var(--spacing) * 4)" },
  toolbar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "calc(var(--spacing) * 2)" },
  minimumWidth: { minWidth: 0 },
  form: { display: "flex", minWidth: 0, flexDirection: "column", gap: "calc(var(--spacing) * 3)" },
  row: { display: "flex", alignItems: "center", gap: "calc(var(--spacing) * 2)" },
  text: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" },
  detail: { fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)", color: "var(--color-muted)" },
  modelList: { maxHeight: "calc(var(--spacing) * 48)", overflowY: "auto", fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" },
  list: { display: "flex", flexDirection: "column", gap: "var(--spacing)" },
  model: { fontFamily: "var(--font-mono)", wordBreak: "break-all" },
  link: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)", color: "var(--color-water)", textDecorationLine: "underline" },
  errorColor: { color: "var(--color-berry)" },
});

const editable = (status: ProviderStatus): ProviderUpdate => ({
  revision: status.revision,
  connections: status.connections.map(({ key: _key, ...connection }) => connection),
  dictation: status.dictation,
  image: status.image,
  understanding: status.understanding,
  speech: status.speech,
  live: status.live,
  speakers: status.speakers,
  voiceDesign: status.voiceDesign,
  transcription: status.transcription,
  vision: status.vision,
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
      {...stylex.attrs(viewStyles.content)}
      data-testid="provider-form"
      data-revision={base().revision}
    >
      <div {...stylex.attrs(viewStyles.toolbar)}>
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
            styles={viewStyles.minimumWidth}
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
            <div {...stylex.attrs(viewStyles.form)} data-testid="provider-connection" data-id={connection().id}>
              <Field label={t("web.provider.name")}>
                <TextInput
                  data-testid="provider-name"
                  aria-label={t("web.provider.name")}
                  disabled={act.busy()}
                  value={connection().name}
                  onInput={(event) => change(connection().id, { name: event.currentTarget.value })}
                />
              </Field>
              <div {...stylex.attrs(viewStyles.row)}>
                <Checkbox
                  testid="provider-enabled"
                  label={t("web.provider.enabled")}
                  checked={connection().enabled}
                  disabled={act.busy()}
                  onChange={(enabled) => change(connection().id, { enabled })}
                />
                <span {...stylex.attrs(viewStyles.text)}>{t("web.provider.enabled")}</span>
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
              <div {...stylex.attrs(viewStyles.toolbar)}>
                <Button data-testid="provider-models" disabled={act.busy() || dirty()} onClick={() => void discover(connection().id)}>
                  {t("web.provider.discover")}
                </Button>
                <span {...stylex.attrs(viewStyles.detail)}>{dirty() ? t("web.provider.saveFirst") : t("web.provider.discoveryHint")}</span>
              </div>
              <Show when={!dirty() && listing()?.revision === base().revision && listing()?.connection === connection().id ? listing() : undefined}>
                {(result) => (
                  <div data-testid="provider-model-list" {...stylex.attrs(viewStyles.modelList)}>
                    <Show when={result().models.length > 0} fallback={<Quiet>{t("web.provider.noModels")}</Quiet>}>
                      <ul {...stylex.attrs(viewStyles.list)}>
                        <For each={result().models}>{(model) => <li {...stylex.attrs(viewStyles.model)}>{model.id}</li>}</For>
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
            value={draft().live?.connection ?? ""}
            options={choices()}
            onChange={(connection) =>
              setDraft((current) => ({
                ...current,
                live: connection ? { connection, model: current.live?.model ?? base().liveModels[0] ?? "" } : null,
              }))
            }
          />
        </Field>
        <Show when={draft().live}>
          <Field label={t("web.provider.capabilityModel")}>
            <Select
              label={t("web.provider.capabilityModel")}
              testid="provider-live-model"
              disabled={act.busy()}
              value={draft().live?.model ?? ""}
              options={base().liveModels.map((model) => ({ value: model, label: model }))}
              onChange={(model) => setDraft((current) => ({ ...current, live: current.live ? { ...current.live, model } : null }))}
            />
          </Field>
        </Show>
        <p {...stylex.attrs(viewStyles.detail)}>{t("web.provider.bindingHint")}</p>
      </Card>
      <Card title={t("web.provider.imageSettings")}>
        <p {...stylex.attrs(viewStyles.detail)} data-testid="provider-image-notice">
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
        <p {...stylex.attrs(viewStyles.detail)} data-testid="provider-understanding-notice">
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
        <p {...stylex.attrs(viewStyles.detail)} data-testid="provider-speech-notice">
          {t("web.provider.speechNotice")}
        </p>
        <Link href="/media?mode=speech" data-testid="provider-speech-open" {...stylex.attrs(viewStyles.link)}>
          {t("web.provider.openSpeech")}
        </Link>
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
      <For each={["speakers", "voiceDesign", "transcription", "vision"] as const}>
        {(use) => (
          <Card title={t(`web.provider.${use}Settings`)}>
            <p {...stylex.attrs(viewStyles.detail)}>{t("web.provider.capabilityNotice")}</p>
            <Field label={t("web.provider.capabilityConnection")}>
              <Select
                label={t("web.provider.capabilityConnection")}
                testid={`provider-${use}`}
                placeholder={t("web.provider.unbound")}
                disabled={act.busy()}
                value={draft()[use]?.connection ?? ""}
                options={choices()}
                onChange={(connection) =>
                  setDraft((current) => ({
                    ...current,
                    [use]: connection ? { connection, model: current[use]?.model ?? base()[`${use}Models`][0] ?? "" } : null,
                  }))
                }
              />
            </Field>
            <Show when={draft()[use]}>
              <Field label={t("web.provider.capabilityModel")}>
                <Select
                  label={t("web.provider.capabilityModel")}
                  testid={`provider-${use}-model`}
                  disabled={act.busy()}
                  value={draft()[use]?.model ?? ""}
                  options={base()[`${use}Models`].map((model) => ({ value: model, label: model }))}
                  onChange={(model) =>
                    setDraft((current) => {
                      const binding = current[use];
                      return { ...current, [use]: binding ? { ...binding, model } : null };
                    })
                  }
                />
              </Field>
            </Show>
          </Card>
        )}
      </For>
      <SaveBar
        dirty={dirty()}
        busy={act.busy()}
        onSave={() => void save()}
        onUndo={() => accept(base())}
        left={
          <Show when={error()}>
            {(why) => (
              <p data-testid="provider-error" role="alert" {...stylex.attrs(viewStyles.errorColor)}>
                {why()}
              </p>
            )}
          </Show>
        }
      />
    </fieldset>
  );
}
