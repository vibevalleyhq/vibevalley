import { createSignal, For, Show, untrack } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import type { ProviderConnectionUpdate, ProviderModelListing, ProviderStatus, ProviderUpdate } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { api, reasonOf } from "#/infra/api.ts";
import { providerQuery, ready, settingsQuery, useQuery, useQueryClient } from "#/infra/query.ts";
import { Link } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { SettingsPage } from "#/ui/domain/settings.tsx";
import { Field, Select, TextInput } from "#/ui/Field.tsx";
import { OutLink } from "#/ui/IconButton.tsx";
import { KeyField, SaveBar } from "#/ui/KeyField.tsx";
import { Card, Quiet, SecretInput } from "#/ui/layout.tsx";
import { Hint } from "#/ui/Tip.tsx";

/** The uses a connection serves, in the groups the page shows them in; each one's words where it needs some. */
const useGroups = [
  {
    title: "groupImage",
    uses: [
      { use: "image", hint: "imageNotice" },
      { use: "understanding", hint: "understandingNotice" },
    ],
  },
  {
    title: "groupVoice",
    uses: [
      { use: "dictation", hint: "modelHint" },
      { use: "speech", hint: "speechNotice" },
      { use: "speakers" },
      { use: "voiceDesign" },
      { use: "transcription" },
    ],
  },
  { title: "groupLive", uses: [{ use: "live", hint: "liveHint" }, { use: "vision" }] },
] as const;

/** The uses an account serves, in the order the uses table shows them: what the account page lists as its models. */
const adaptedUses = ["image", "understanding", "dictation", "speech", "speakers", "voiceDesign", "transcription", "live", "vision"] as const;

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

/** Which of the providers' settings a place shows: the MOSS accounts (with the other keys, on the accounts page), or
 * the uses each feature is bound to. Each saves the whole settings, its own part changed. */
type ProviderPart = "accounts" | "uses";

function Provider(props: { part: ProviderPart }) {
  const query = useQuery(providerQuery);
  return (
    <Show when={ready(query, undefined)} fallback={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.base.form.asking")}</Quiet>}>
      {(status) => <ProviderForm initial={untrack(status)} part={props.part} />}
    </Show>
  );
}

/** The uses: which account and model each feature calls. */
export function ProviderPage() {
  return (
    <SettingsPage title={t("web.provider.title")} hint={t("web.provider.intro")}>
      <Provider part="uses" />
    </SettingsPage>
  );
}

/** The MOSS accounts, for the accounts page. */
export function MossAccounts() {
  return <Provider part="accounts" />;
}

function ProviderForm(props: { initial: ProviderStatus; part: ProviderPart }) {
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
      class="flex max-w-3xl min-w-0 flex-col gap-6"
      data-testid="provider-form"
      data-revision={base().revision}
    >
      <Show when={props.part === "accounts"}>
        <section class="flex min-w-0 flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="flex-1 text-sm font-semibold">MOSS</h2>
            <OutLink href="https://platform.moss.cn/" label={t("web.provider.console")} />
            <ConfirmButton
              testid="provider-reload"
              label={t("web.provider.reload")}
              question={t("web.provider.reloadAsk")}
              disabled={act.busy()}
              onConfirm={() => void reload()}
            />
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
          </div>
          <Show when={draft().connections.length === 0}>
            <Quiet>{t("web.provider.empty")}</Quiet>
          </Show>
          <For each={draft().connections} keyed={(connection) => connection.id}>
            {(connection) => (
              <Card
                title={connection().name || "MOSS"}
                testid="provider-connection"
                item={connection().id}
                class="min-w-0"
                action={
                  <div class="flex flex-wrap items-center gap-2">
                    <Button data-testid="provider-models" disabled={act.busy() || dirty()} onClick={() => void discover(connection().id)}>
                      {t("web.provider.discover")}
                    </Button>
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
                  </div>
                }
              >
                <div class="flex min-w-0 flex-col gap-3">
                  <div class="flex flex-wrap items-end gap-3">
                    <div class="min-w-48 flex-1">
                      <Field label={t("web.provider.name")}>
                        <TextInput
                          data-testid="provider-name"
                          aria-label={t("web.provider.name")}
                          disabled={act.busy()}
                          value={connection().name}
                          onInput={(event) => change(connection().id, { name: event.currentTarget.value })}
                        />
                      </Field>
                    </div>
                    <div class="flex h-7 items-center gap-2">
                      <Checkbox
                        testid="provider-enabled"
                        label={t("web.provider.enabled")}
                        checked={connection().enabled}
                        disabled={act.busy()}
                        onChange={(enabled) => change(connection().id, { enabled })}
                      />
                      <span class="text-sm">{t("web.provider.enabled")}</span>
                    </div>
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
                        onInput={(event) =>
                          event.currentTarget.value ? change(connection().id, { key: event.currentTarget.value }) : keepKey(connection().id)
                        }
                      />
                    </KeyField>
                  </div>
                  <details data-testid="provider-adapted">
                    <summary class="text-xs text-muted">{t("web.provider.adapted")}</summary>
                    <ul class="flex flex-col gap-1">
                      <For each={adaptedUses}>
                        {(use) => (
                          <li class="text-sm">
                            {t(`web.provider.use.${use}`)}
                            <span class="text-xs text-muted"> {list(base()[`${use}Models`])}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </details>
                  <p class="text-xs text-muted">{dirty() ? t("web.provider.saveFirst") : t("web.provider.discoveryHint")}</p>
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
        </section>
      </Show>
      <Show when={props.part === "uses"}>
        <Card title={t("web.provider.uses")}>
          <p class="text-xs text-muted">{t("web.provider.usesIntro")}</p>
          <div class="flex min-w-0 flex-col">
            <For each={useGroups}>
              {(group) => (
                <>
                  <div class="pt-3 pb-1 text-xs font-semibold text-muted">{t(`web.provider.${group.title}`)}</div>
                  <For each={group.uses}>
                    {(item) => {
                      const use = item.use;
                      const name = t(`web.provider.use.${use}`);
                      return (
                        <div data-testid="provider-use" data-key={use} class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2">
                          <span class="flex w-32 items-center gap-1.5 text-sm">
                            {name}
                            <Show when={"hint" in item ? item.hint : undefined}>{(hint) => <Hint text={t(`web.provider.${hint()}`)} />}</Show>
                            <Show when={use === "speech"}>
                              <Link href="/library?make=speech" data-testid="provider-speech-open" class="text-xs text-water underline">
                                {t("web.provider.openSpeechShort")}
                              </Link>
                            </Show>
                          </span>
                          <div class="grid min-w-60 flex-1 grid-cols-[1fr_1fr] gap-2">
                            <Select
                              label={t("web.provider.connectionFor", { use: name })}
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
                            <Show when={draft()[use]}>
                              <Select
                                label={t("web.provider.modelFor", { use: name })}
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
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </>
              )}
            </For>
          </div>
          <p class="text-xs text-muted">{t("web.provider.bindingHint")}</p>
        </Card>
      </Show>
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
