import * as stylex from "@stylexjs/stylex";
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
import { Field, Select, TextInput } from "#/ui/Field.tsx";
import { OutLink } from "#/ui/IconButton.tsx";
import { KeyField, SaveBar } from "#/ui/KeyField.tsx";
import { Card, Quiet, SecretInput } from "#/ui/layout.tsx";
import { SettingsPage } from "#/ui/settings.tsx";
import { Hint } from "#/ui/Tip.tsx";

const viewStyles = stylex.create({
  content: { display: "flex", maxWidth: "var(--container-3xl)", minWidth: 0, flexDirection: "column", gap: "calc(var(--spacing) * 6)" },
  section: { display: "flex", minWidth: 0, flexDirection: "column", gap: "calc(var(--spacing) * 3)" },
  sectionHead: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "calc(var(--spacing) * 2)" },
  sectionTitle: { flex: "1", fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)", fontWeight: 600 },
  toolbar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "calc(var(--spacing) * 2)" },
  minimumWidth: { minWidth: 0 },
  form: { display: "flex", minWidth: 0, flexDirection: "column", gap: "calc(var(--spacing) * 3)" },
  nameRow: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "calc(var(--spacing) * 3)" },
  nameField: { minWidth: "calc(var(--spacing) * 48)", flex: "1" },
  row: { display: "flex", height: "calc(var(--spacing) * 7)", alignItems: "center", gap: "calc(var(--spacing) * 2)" },
  text: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" },
  detail: { fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)", color: "var(--color-muted)" },
  modelList: { maxHeight: "calc(var(--spacing) * 48)", overflowY: "auto", fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" },
  list: { display: "flex", flexDirection: "column", gap: "var(--spacing)" },
  model: { fontFamily: "var(--font-mono)", wordBreak: "break-all" },
  link: { fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)", color: "var(--color-water)", textDecorationLine: "underline" },
  errorColor: { color: "var(--color-berry)" },
  // One use a line: its name, then its connection and model side by side, wrapping under the name when narrow.
  uses: { display: "flex", minWidth: 0, flexDirection: "column" },
  group: {
    paddingTop: "calc(var(--spacing) * 3)",
    paddingBottom: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: 600,
    color: "var(--color-muted)",
  },
  use: {
    display: "flex",
    minWidth: 0,
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "calc(var(--spacing) * 3)",
    rowGap: "var(--spacing)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  useName: {
    display: "flex",
    width: "calc(var(--spacing) * 32)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  usePicks: { display: "grid", minWidth: "calc(var(--spacing) * 60)", flex: "1", gridTemplateColumns: "1fr 1fr", gap: "calc(var(--spacing) * 2)" },
});

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
      {...stylex.attrs(viewStyles.content)}
      data-testid="provider-form"
      data-revision={base().revision}
    >
      <Show when={props.part === "accounts"}>
        <section {...stylex.attrs(viewStyles.section)}>
          <div {...stylex.attrs(viewStyles.sectionHead)}>
            <h2 {...stylex.attrs(viewStyles.sectionTitle)}>MOSS</h2>
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
                styles={viewStyles.minimumWidth}
                action={
                  <div {...stylex.attrs(viewStyles.toolbar)}>
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
                <div {...stylex.attrs(viewStyles.form)}>
                  <div {...stylex.attrs(viewStyles.nameRow)}>
                    <div {...stylex.attrs(viewStyles.nameField)}>
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
                    <summary {...stylex.attrs(viewStyles.detail)}>{t("web.provider.adapted")}</summary>
                    <ul {...stylex.attrs(viewStyles.list)}>
                      <For each={adaptedUses}>
                        {(use) => (
                          <li {...stylex.attrs(viewStyles.text)}>
                            {t(`web.provider.use.${use}`)}
                            <span {...stylex.attrs(viewStyles.detail)}> {list(base()[`${use}Models`])}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </details>
                  <p {...stylex.attrs(viewStyles.detail)}>{dirty() ? t("web.provider.saveFirst") : t("web.provider.discoveryHint")}</p>
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
        </section>
      </Show>
      <Show when={props.part === "uses"}>
        <Card title={t("web.provider.uses")}>
          <p {...stylex.attrs(viewStyles.detail)}>{t("web.provider.usesIntro")}</p>
          <div {...stylex.attrs(viewStyles.uses)}>
            <For each={useGroups}>
              {(group) => (
                <>
                  <div {...stylex.attrs(viewStyles.group)}>{t(`web.provider.${group.title}`)}</div>
                  <For each={group.uses}>
                    {(item) => {
                      const use = item.use;
                      const name = t(`web.provider.use.${use}`);
                      return (
                        <div data-testid="provider-use" data-key={use} {...stylex.attrs(viewStyles.use)}>
                          <span {...stylex.attrs(viewStyles.useName)}>
                            {name}
                            <Show when={"hint" in item ? item.hint : undefined}>{(hint) => <Hint text={t(`web.provider.${hint()}`)} />}</Show>
                            <Show when={use === "speech"}>
                              <Link href="/library?make=speech" data-testid="provider-speech-open" {...stylex.attrs(viewStyles.link)}>
                                {t("web.provider.openSpeechShort")}
                              </Link>
                            </Show>
                          </span>
                          <div {...stylex.attrs(viewStyles.usePicks)}>
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
          <p {...stylex.attrs(viewStyles.detail)}>{t("web.provider.bindingHint")}</p>
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
