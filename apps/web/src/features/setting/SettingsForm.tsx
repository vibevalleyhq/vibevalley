import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Show, snapshot, Switch as Pick, untrack } from "solid-js";

import { t, currentLocale } from "@vibevalley/i18n";
import {
  type GitHubStatus,
  type Locale,
  LocaleValues,
  type MemorySource,
  type MemorySourceKind,
  MemorySourceKindValues,
  type SettingsStatus,
  type SettingsUpdate,
} from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { api, reasonOf } from "#/infra/api.ts";
import { defineQuery, retryRead, ready, useQuery, useSettings } from "#/infra/query.ts";
import { useSaveSettings } from "#/infra/settings.ts";
import { createAct } from "#/ui/act.ts";
import { TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { KeyField, SaveBar } from "#/ui/KeyField.tsx";
import { Quiet, SecretInput, Toggle } from "#/ui/layout.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { SettingRow, SettingsGroup } from "#/ui/settings.tsx";
import { Hint, Tip } from "#/ui/Tip.tsx";
import { toast } from "#/ui/toasts.ts";

import { DeepseekForm } from "./DeepseekForm";

const recipeStyles = stylex.create({
  sourceMarkSpan: {
    display: "block",
    width: "calc(var(--spacing) * 2)",
    height: "calc(var(--spacing) * 2)",
    borderRadius: "2147483647px",
  },
  sourceMarkSpanState: {
    backgroundColor: "var(--wb-faint)",
    borderStyle: null,
    borderWidth: null,
    borderColor: null,
  },
  sourceMarkSpanState2: {
    backgroundColor: "var(--wb-leaf)",
    borderStyle: null,
    borderWidth: null,
    borderColor: null,
  },
  sourceMarkSpanState3: {
    backgroundColor: null,
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-faint)",
  },
});

const variantStyles = stylex.create({
  sourceFieldTextInput: {
    fontFamily: "var(--font-mono)",
  },
});

const viewStyles = stylex.create({
  memoryFormForm: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
  },
  memoryFormP: {
    color: "var(--color-berry)",
  },
  sourceMark: {
    display: "inline-flex",
    padding: "var(--spacing)",
    outlineStyle: {
      default: "none",
      ":focus-visible": "none",
    },
    outlineWidth: {
      default: null,
      ":focus-visible": "2px",
    },
    outlineColor: {
      default: null,
      ":focus-visible": "var(--color-focus)",
    },
  },
  sourceFieldDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 3)",
  },
  sourceFieldSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  sourceFieldSpan2: {
    flex: "1",
  },
  sourceFieldDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 3)",
  },
  sourceFieldDiv3: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: "calc(var(--spacing) * 6)",
    rowGap: "calc(var(--spacing) * 2.5)",
  },
  gitHubDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  gitHubSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  gitHubSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  gitHubP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
});

type SettingsPart = "deepseek" | "memory";

const sourceLabels: Record<MemorySourceKind, string> = { nowledge: "Nowledge Mem", everos: "EverOS" };
const sourceAddress: Record<MemorySourceKind, string> = { nowledge: "http://127.0.0.1:14242/mcp/", everos: "http://127.0.0.1:18791" };

/** One memory source as the form edits it, from what is saved until it is saved again. */
interface SourceDraft {
  readonly kind: MemorySourceKind;
  readonly saved: MemorySource | undefined;
  url: string;
  user: string;
  key: string;
  enabled: boolean;
  read: boolean;
  write: boolean;
  everything: boolean;
  keyCleared: boolean;
  /** Only a source touched is sent: the list goes whole, and an untouched one must not undo a change made elsewhere. */
  changed: boolean;
  open: boolean;
}

const draftOf = (kind: MemorySourceKind, saved: MemorySource | undefined): SourceDraft => ({
  kind,
  saved,
  url: saved?.url ?? "",
  user: saved?.user ?? "",
  key: "",
  enabled: saved?.enabled ?? false,
  read: saved?.read ?? true,
  write: saved?.write ?? true,
  everything: saved?.everything ?? false,
  keyCleared: false,
  changed: false,
  open: false,
});

const draftsOf = (status: SettingsStatus) =>
  MemorySourceKindValues.map((k) =>
    draftOf(
      k,
      status.memorySources.find((m) => m.kind === k),
    ),
  );

/** Where the settings are kept, said on hover: a card's header puts it beside its title. */
export function SettingsFile() {
  const settings = useSettings();
  return <Show when={ready(settings, undefined)}>{(s) => <Hint icon="file" text={t("web.base.form.storedIn", { file: s().file })} />}</Show>;
}

/** Built again for each part (Keyed by the page): a saved form starts over from what the server answered. */
export function SettingsForm(props: { part: SettingsPart }) {
  const settings = useSettings();
  return (
    <Pick fallback={<Quiet>{t("web.base.form.asking")}</Quiet>}>
      <Match when={settings.error()}>{(e) => <Quiet>{t("web.base.form.unreachable", { why: reasonOf(e()) })}</Quiet>}</Match>
      <Match when={ready(settings, undefined)}>
        {(status) => (
          <Show when={props.part === "deepseek"} fallback={<MemoryForm status={untrack(status)} />}>
            <DeepseekForm status={untrack(status)} />
          </Show>
        )}
      </Match>
    </Pick>
  );
}

function MemoryForm(props: { status: SettingsStatus }) {
  const saveSettings = useSaveSettings();
  // A plain copy: the form starts from it once, and reading the store's fields later would be untracked reads.
  const start = untrack(() => snapshot(props.status));
  const [status, setStatus] = createSignal(start);
  const [sources, setSources] = createSignal(draftsOf(start));
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const busy = act.busy;

  const setSource = (kind: MemorySourceKind, change: Partial<SourceDraft>, touched = true) =>
    setSources((all) => all.map((d) => (d.kind === kind ? { ...d, ...change, changed: d.changed || touched } : d)));
  const dirty = () => sources().some((d) => d.changed);
  const undo = () => {
    setSources(draftsOf(status()).map((d, i) => ({ ...d, open: sources()[i]?.open ?? false })));
    setError(undefined);
  };

  const submit = async () => {
    const update: SettingsUpdate = omitUndefined({
      memorySources: !sources().some((d) => d.changed)
        ? undefined
        : sources()
            .filter((d) => d.url.trim() !== "" || d.enabled)
            .map((d) => ({
              kind: d.kind,
              url: d.url.trim(),
              enabled: d.enabled,
              read: d.read,
              write: d.write,
              ...(d.everything ? { everything: true } : {}),
              ...(d.user.trim() ? { user: d.user.trim() } : {}),
              ...(d.key.trim() ? { key: d.key.trim() } : d.keyCleared ? { key: "" } : {}),
            })),
    });
    setError(undefined);
    await act.run(async () => {
      const now = await saveSettings(update);
      setStatus(now);
      setSources(draftsOf(now));
      toast(t("web.setting.keys.saved"));
    });
  };

  return (
    <form
      {...stylex.attrs(viewStyles.memoryFormForm)}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy() && dirty()) void submit();
      }}
    >
      <SettingsGroup>
        <For each={sources()} keyed={(d) => d.kind}>
          {(d) => <SourceField draft={d()} set={(change, touched) => setSource(d().kind, change, touched)} />}
        </For>
      </SettingsGroup>
      <Show when={dirty() || error()}>
        <SaveBar
          dirty={dirty()}
          busy={busy()}
          onSave={() => void submit()}
          onUndo={undo}
          left={<Show when={error()}>{(e) => <p {...stylex.attrs(viewStyles.memoryFormP)}>{e()}</p>}</Show>}
        />
      </Show>
    </form>
  );
}

/** A memory source's state as a dot: not set up, on, or off; what and where on hover. */
function SourceMark(props: { draft: SourceDraft }) {
  const text = () =>
    !props.draft.saved
      ? t("web.setting.source.off")
      : props.draft.saved.enabled
        ? `${t("web.setting.source.on")} · ${props.draft.saved.url}`
        : t("web.setting.source.closed");
  return (
    <Tip text={text()}>
      <span
        role="img"
        data-testid="source-mark"
        data-state={!props.draft.saved ? "unset" : props.draft.saved.enabled ? "on" : "off"}
        aria-label={text()}
        tabindex={0}
        {...stylex.attrs(viewStyles.sourceMark)}
      >
        <span
          {...stylex.attrs(
            recipeStyles.sourceMarkSpan,
            !props.draft.saved
              ? recipeStyles.sourceMarkSpanState3
              : props.draft.saved.enabled
                ? recipeStyles.sourceMarkSpanState2
                : recipeStyles.sourceMarkSpanState,
          )}
        />
      </span>
    </Tip>
  );
}

function SourceField(props: { draft: SourceDraft; set: (change: Partial<SourceDraft>, touched?: boolean) => void }) {
  const label = () => sourceLabels[props.draft.kind];
  return (
    <div data-testid="source" data-key={props.draft.kind}>
      <div {...stylex.attrs(viewStyles.sourceFieldDiv)}>
        <span {...stylex.attrs(viewStyles.sourceFieldSpan)}>{label()}</span>
        <SourceMark draft={props.draft} />
        <span {...stylex.attrs(viewStyles.sourceFieldSpan2)} />
        <Toggle
          label={t("web.setting.source.enabled")}
          ariaLabel={t("web.setting.source.enable", { label: label() })}
          testid="source-enable"
          checked={props.draft.enabled}
          onChange={(enabled) => props.set({ enabled, open: props.draft.open || (enabled && !props.draft.url) })}
        />
        <IconButton
          icon="settings"
          testid="source-configure"
          label={t("web.setting.source.configure", { label: label() })}
          pressed={props.draft.open}
          onClick={() => props.set({ open: !props.draft.open }, false)}
        />
      </div>
      <Show when={props.draft.open}>
        <div {...stylex.attrs(viewStyles.sourceFieldDiv2)}>
          <TextInput
            data-testid="source-address"
            aria-label={t("web.setting.source.address", { label: label() })}
            styles={variantStyles.sourceFieldTextInput}
            placeholder={sourceAddress[props.draft.kind]}
            value={props.draft.url}
            onInput={(e) => props.set({ url: e.currentTarget.value })}
          />
          <KeyField
            label="key"
            status={props.draft.saved?.key ?? { source: null }}
            removing={props.draft.keyCleared}
            onRemove={(keyCleared) => props.set({ keyCleared })}
            tip={t("web.setting.source.noKey")}
          >
            <SecretInput
              aria-label={t("web.setting.source.key", { label: label() })}
              placeholder={t("web.setting.source.keyHint")}
              value={props.draft.key}
              onInput={(e) => props.set({ key: e.currentTarget.value })}
            />
          </KeyField>
          <Show when={props.draft.kind === "everos"}>
            <TextInput
              aria-label={t("web.setting.source.user", { label: label() })}
              placeholder={t("web.setting.source.userHint")}
              value={props.draft.user}
              onInput={(e) => props.set({ user: e.currentTarget.value })}
            />
          </Show>
          <div {...stylex.attrs(viewStyles.sourceFieldDiv3)}>
            <Toggle
              label={t("web.setting.source.read")}
              tip={t("web.setting.source.readHint")}
              checked={props.draft.read}
              onChange={(read) => props.set({ read })}
            />
            <Toggle
              label={t("web.setting.source.write")}
              tip={t("web.setting.source.writeHint")}
              checked={props.draft.write}
              onChange={(write) => props.set({ write })}
            />
            <Show when={props.draft.kind === "nowledge"}>
              <Toggle
                label={t("web.setting.source.everything")}
                tip={t("web.setting.source.everythingHint")}
                checked={props.draft.everything}
                onChange={(everything) => props.set({ everything })}
              />
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

/** What the server found of gh (github.status); the refresh asks it to look again. */
const githubQuery = defineQuery({ schema: S.GitHubStatus, key: () => ["github"], fetch: (_: void, context) => api.github.get(context), ...retryRead });
export function GitHub() {
  const [refreshed, setRefreshed] = createSignal<GitHubStatus>();
  const [error, setError] = createSignal<string>();
  // A refusal shows under the status it was asked about.
  const act = createAct(setError);
  const busy = act.busy;
  const status = useQuery(githubQuery);
  const now = () => refreshed() ?? ready(status, undefined);
  const recheck = () => {
    setError(undefined);
    return act.run(async () => setRefreshed(await api.github.refresh()));
  };
  return (
    <div {...stylex.attrs(viewStyles.gitHubDiv)}>
      <Pick fallback={<Quiet>{status.error() ? t("web.base.form.unreachable", { why: reasonOf(status.error()) }) : t("web.base.form.asking")}</Quiet>}>
        <Match when={now()}>
          {(s) => (
            <SettingsGroup>
              <SettingRow label={t("web.setting.github.cli")} hint={t("web.setting.github.cliHint")} tip={s().reason}>
                <Icon name={s().installed ? "check" : "cross"} size={16} />
                <span {...stylex.attrs(viewStyles.gitHubSpan)}>{s().installed ? s().version : t("web.setting.github.noGh")}</span>
                <IconButton icon="refresh" testid="github-recheck" label={t("web.setting.github.recheck")} disabled={busy()} onClick={() => void recheck()} />
              </SettingRow>
              <SettingRow label={t("web.setting.github.login")} hint={t("web.setting.github.loginHint")}>
                <Icon name={s().loggedIn ? "check" : "warn"} size={16} />
                <span {...stylex.attrs(viewStyles.gitHubSpan2)}>{s().loggedIn ? s().account : t("web.setting.github.notLoggedIn")}</span>
              </SettingRow>
            </SettingsGroup>
          )}
        </Match>
      </Pick>
      <Show when={error()}>
        <p {...stylex.attrs(viewStyles.gitHubP)}>{error()}</p>
      </Show>
    </div>
  );
}

/** The farm's language: the page's words, what the orchestrator and the helpers answer in, what goes to the chat apps. */
export function LanguageChoice() {
  const saveSettings = useSaveSettings();
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const busy = act.busy;
  const choose = async (locale: Locale) => {
    if (locale === currentLocale() || busy()) return;
    setError(undefined);
    if (await act.run(() => saveSettings({ locale }))) location.reload();
  };
  return (
    <>
      <Show when={error()}>{(e) => <Hint text={e()} />}</Show>
      <Segmented
        label={t("web.setting.language.label")}
        testid="language"
        value={currentLocale()}
        options={LocaleValues.map((l) => ({ value: l, label: t(`web.setting.language.${l}`), disabled: busy() }))}
        onChange={(l) => void choose(l)}
      />
    </>
  );
}
