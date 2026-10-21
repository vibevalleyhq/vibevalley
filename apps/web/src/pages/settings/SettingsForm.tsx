// The keys and the memory sources (setting.load, setting.save), a part at a time; and what the server found of gh.

import { createSignal, For, Match, Show, snapshot, Switch as Pick, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";

import {
  type GitHubStatus,
  type KeySource,
  type KeyStatus,
  type MemorySource,
  type MemorySourceKind,
  MemorySourceKindValues,
  type SettingsStatus,
  type SettingsUpdate,
} from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { queries, ready, useQuery, useSettings } from "../../data/query";
import { Button } from "../../ui/Button";
import { TextInput } from "../../ui/Field";
import { Quiet, SecretInput, TextLink, Toggle } from "../kit";

const from: Record<KeySource, string> = { settings: "存在设置里", config: "来自配置（vibevalley.yaml 或环境变量）" };
const keyLine = (k: KeyStatus) => (k.source ? `在用 ${k.hint ?? ""}（${from[k.source]}）` : "还没有");

export type SettingsPart = "deepseek" | "agora" | "memory";

/** Saves, and the settings the server answers with are the cached ones from then on. */
export async function saveSettings(update: SettingsUpdate) {
  const saved = await api.setting.save({ body: update });
  queries.setQueryData(["settings"], saved);
  return saved;
}

type Key = "deepseekApiKey" | "agoraAppId" | "agoraAppCertificate";

const sourceLabels: Record<MemorySourceKind, string> = { nowledge: "Nowledge Mem", everos: "EverOS" };
const sourceAddress: Record<MemorySourceKind, string> = { nowledge: "http://127.0.0.1:14242/mcp/", everos: "http://127.0.0.1:18791" };

/** One memory source as the form edits it, from what is saved until it is saved again. */
interface SourceDraft {
  readonly kind: MemorySourceKind;
  readonly saved?: MemorySource;
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

/** Built again for each part (Keyed by the page): a saved form starts over from what the server answered. */
export function SettingsForm(props: { part: SettingsPart }) {
  const settings = useSettings();
  return (
    <Pick fallback={<Quiet>在问服务端……</Quiet>}>
      <Match when={settings.error}>{(e) => <Quiet>问不到服务端：{reasonOf(e())}</Quiet>}</Match>
      <Match when={ready(settings, undefined)}>{(status) => <Form part={props.part} status={untrack(status)} />}</Match>
    </Pick>
  );
}

function Form(props: { part: SettingsPart; status: SettingsStatus }) {
  // A plain copy: the form starts from it once, and reading the store's fields later would be untracked reads.
  const start = untrack(() => snapshot(props.status));
  const [status, setStatus] = createSignal(start);
  const [deepseek, setDeepseek] = createSignal("");
  const [certificate, setCertificate] = createSignal("");
  const [appId, setAppId] = createSignal(start.agoraAppId.value ?? "");
  const [cleared, setCleared] = createSignal<ReadonlySet<Key>>(new Set());
  const [sources, setSources] = createSignal(
    MemorySourceKindValues.map((k) =>
      draftOf(
        k,
        start.memorySources.find((m) => m.kind === k),
      ),
    ),
  );
  const [error, setError] = createSignal<string>();
  const [saved, setSaved] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const typed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setSaved(false);
    };
  const clear = (k: Key) => typed(setCleared)(new Set([...cleared(), k]));
  const setSource = (kind: MemorySourceKind, change: Partial<SourceDraft>, touched = true) => {
    setSources((all) => all.map((d) => (d.kind === kind ? { ...d, ...change, changed: d.changed || touched } : d)));
    setSaved(false);
  };

  const submit = async () => {
    // A key cleared and not typed again goes as "" (the server forgets it).
    const value = (k: Key, v: string) => (v.trim() ? v.trim() : cleared().has(k) ? "" : undefined);
    const id = appId().trim();
    const update: SettingsUpdate = {
      deepseekApiKey: value("deepseekApiKey", deepseek()),
      agoraAppId: id !== (status().agoraAppId.value ?? "") ? id : cleared().has("agoraAppId") ? "" : undefined,
      agoraAppCertificate: value("agoraAppCertificate", certificate()),
      memorySources: !sources().some((d) => d.changed)
        ? undefined
        : sources()
            .filter((d) => d.url.trim() || d.enabled)
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
    };
    setBusy(true);
    setError(undefined);
    try {
      const now = await saveSettings(update);
      setStatus(now);
      setDeepseek("");
      setCertificate("");
      setAppId(now.agoraAppId.value ?? "");
      setCleared(new Set<Key>());
      setSources(
        MemorySourceKindValues.map((k) =>
          draftOf(
            k,
            now.memorySources.find((m) => m.kind === k),
          ),
        ),
      );
      setSaved(true);
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      class="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy()) void submit();
      }}
    >
      <Show when={props.part === "deepseek"}>
        <KeyField
          label="DeepSeek API Key"
          help={<TextLink href="https://platform.deepseek.com/api_keys">platform.deepseek.com</TextLink>}
          line={cleared().has("deepseekApiKey") ? "存的时候清掉" : keyLine(status().deepseekApiKey)}
          onClear={status().deepseekApiKey.source === "settings" && !cleared().has("deepseekApiKey") ? () => clear("deepseekApiKey") : undefined}
        >
          <SecretInput
            aria-label="DeepSeek API Key"
            placeholder="sk-…（不改就空着）"
            value={deepseek()}
            onInput={(e) => typed(setDeepseek)(e.currentTarget.value)}
          />
        </KeyField>
      </Show>
      <Show when={props.part === "agora"}>
        <KeyField
          label="Agora App ID"
          help={<TextLink href="https://console.agora.io/">console.agora.io</TextLink>}
          line={cleared().has("agoraAppId") ? "存的时候清掉" : status().agoraAppId.source ? `（${from[status().agoraAppId.source!]}）` : "还没有"}
          onClear={status().agoraAppId.source === "settings" && !cleared().has("agoraAppId") ? () => clear("agoraAppId") : undefined}
        >
          <TextInput
            aria-label="Agora App ID"
            class="font-mono"
            placeholder="32 位，比如 0123…cdef"
            value={appId()}
            onInput={(e) => typed(setAppId)(e.currentTarget.value)}
          />
        </KeyField>
        <KeyField
          label="Agora App Certificate"
          help={<span class="text-xs text-muted">和 App ID 在同一个项目里</span>}
          line={cleared().has("agoraAppCertificate") ? "存的时候清掉" : keyLine(status().agoraAppCertificate)}
          onClear={status().agoraAppCertificate.source === "settings" && !cleared().has("agoraAppCertificate") ? () => clear("agoraAppCertificate") : undefined}
        >
          <SecretInput
            aria-label="Agora App Certificate"
            placeholder="不改就空着"
            value={certificate()}
            onInput={(e) => typed(setCertificate)(e.currentTarget.value)}
          />
        </KeyField>
      </Show>
      <Show when={props.part === "memory"}>
        <For each={sources()} keyed={(d) => d.kind}>
          {(d) => <SourceField draft={d()} set={(change, touched) => setSource(d().kind, change, touched)} />}
        </For>
      </Show>
      <Show when={error()}>
        <p class="text-sm text-berry">{error()}</p>
      </Show>
      <Show when={saved()}>
        <p class="text-sm text-accent">存好了，马上就用上。</p>
      </Show>
      <div class="flex items-center gap-3 border-t border-line pt-3">
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={status().file}>
          {status().file}
        </span>
        <Button type="submit" tone="primary" disabled={busy()}>
          保存
        </Button>
      </div>
    </form>
  );
}

function SourceField(props: { draft: SourceDraft; set: (change: Partial<SourceDraft>, touched?: boolean) => void }) {
  const label = () => sourceLabels[props.draft.kind];
  const savedKey = () => props.draft.saved?.key;
  return (
    <Show
      when={props.draft.open}
      fallback={
        <div class="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
          <span class="flex-1 text-sm font-medium">
            记性的来源：{label()}（{!props.draft.saved ? "没接" : props.draft.saved.enabled ? "接上了" : "关着"}）
          </span>
          <Button aria-label={`改 ${label()}`} onClick={() => props.set({ open: true }, false)}>
            改
          </Button>
        </div>
      }
    >
      <div class="rounded-lg border border-line p-3">
        <KeyField
          label={`记性的来源：${label()}`}
          help={<Toggle label="接上" checked={props.draft.enabled} onChange={(enabled) => props.set({ enabled })} />}
          line={props.draft.keyCleared ? "key 存的时候清掉" : savedKey()?.source ? `key ${keyLine(savedKey()!)}` : "本机的不用 key"}
          onClear={savedKey()?.source === "settings" && !props.draft.keyCleared ? () => props.set({ keyCleared: true }) : undefined}
        >
          <div class="flex flex-col gap-1.5">
            <TextInput
              aria-label={`${label()} 的地址`}
              class="font-mono"
              placeholder={sourceAddress[props.draft.kind]}
              value={props.draft.url}
              onInput={(e) => props.set({ url: e.currentTarget.value })}
            />
            <SecretInput
              aria-label={`${label()} 的 key`}
              placeholder="key（不用或不改就空着）"
              value={props.draft.key}
              onInput={(e) => props.set({ key: e.currentTarget.value })}
            />
            <Show when={props.draft.kind === "everos"}>
              <TextInput
                aria-label={`${label()} 的 user_id`}
                placeholder="你在 EverOS 里的 user_id（空着就是 owner）"
                value={props.draft.user}
                onInput={(e) => props.set({ user: e.currentTarget.value })}
              />
            </Show>
          </div>
          <div class="mt-3 flex flex-wrap gap-x-6 gap-y-2.5">
            <Toggle label="读" hint="开工想起、帮工翻记性时也问它" checked={props.draft.read} onChange={(read) => props.set({ read })} />
            <Toggle label="写" hint="记下的也送一份过去" checked={props.draft.write} onChange={(write) => props.set({ write })} />
            <Show when={props.draft.kind === "nowledge"}>
              <Toggle
                label="读全部"
                hint="不只读农场替帮工记的，主人在里面的记忆每个帮工都读得到"
                checked={props.draft.everything}
                onChange={(everything) => props.set({ everything })}
              />
            </Show>
          </div>
        </KeyField>
      </div>
    </Show>
  );
}

function KeyField(props: { label: string; help: JSX.Element; line: string; onClear?: () => void; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2">
        <span class="flex-1 text-sm font-semibold">{props.label}</span>
        {props.help}
      </div>
      {props.children}
      <div class="flex items-center gap-2">
        <span class="flex-1 text-xs text-muted">{props.line}</span>
        <Show when={props.onClear}>
          <TextLink danger onClick={() => props.onClear?.()}>
            清掉
          </TextLink>
        </Show>
      </div>
    </div>
  );
}

/** What the server found of gh (github.status); a refresh asks it to look again. */
export function GitHub() {
  const [refreshed, setRefreshed] = createSignal<GitHubStatus>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const status = useQuery(() => ({ queryKey: ["github"], queryFn: () => api.github.status() }));
  const lines = () => {
    const s = refreshed() ?? ready(status, undefined);
    return !s
      ? [status.error ? `问不到服务端：${reasonOf(status.error)}` : "在问服务端……"]
      : [s.installed ? `gh ${s.version}` : "没装 gh", ...(s.loggedIn ? [`已登录 github.com：${s.account}`] : []), ...(s.reason ? [s.reason] : [])];
  };
  const recheck = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setRefreshed(await api.github.refresh());
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="flex flex-col gap-1.5">
      <For each={lines()}>{(l) => <p class="text-sm">{l}</p>}</For>
      <p class="text-xs text-muted">能提 PR 的项目在「项目」里看；收获时提 PR 要在配置里打开（github.pr_projects）。</p>
      <Show when={error()}>
        <p class="text-sm text-berry">{error()}</p>
      </Show>
      <div class="pt-2">
        <Button disabled={busy()} onClick={() => void recheck()}>
          重新检测
        </Button>
      </div>
    </div>
  );
}
