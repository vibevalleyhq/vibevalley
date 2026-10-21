// The keys and the memory sources (setting.load, setting.save), a part at a time; and what the server found of gh.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
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
import { Button } from "../../ui/Button";
import { TextInput } from "../../ui/Field";
import { Quiet, SecretInput, Switch, TextLink } from "../kit";

const from: Record<KeySource, string> = { settings: "存在设置里", config: "来自配置（vibevalley.yaml 或环境变量）" };
const keyLine = (k: KeyStatus) => (k.source ? `在用 ${k.hint ?? ""}（${from[k.source]}）` : "还没有");

export type SettingsPart = "deepseek" | "agora" | "memory";

/** The server's settings; saving answers with them as they are now. */
export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => api.setting.load() });
}

export function useSaveSettings() {
  const client = useQueryClient();
  return async (update: SettingsUpdate) => {
    const saved = await api.setting.save({ body: update });
    client.setQueryData(["settings"], saved);
    return saved;
  };
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

/** Keyed by what it shows: a saved form starts over from what the server answered. */
export function SettingsForm({ part }: { part: SettingsPart }) {
  const settings = useSettings();
  if (settings.error) return <Quiet>问不到服务端：{reasonOf(settings.error)}</Quiet>;
  if (!settings.data) return <Quiet>在问服务端……</Quiet>;
  return <Form part={part} status={settings.data} />;
}

function Form({ part, status }: { part: SettingsPart; status: SettingsStatus }) {
  const save = useSaveSettings();
  const [deepseek, setDeepseek] = useState("");
  const [certificate, setCertificate] = useState("");
  const [appId, setAppId] = useState(status.agoraAppId.value ?? "");
  const [cleared, setCleared] = useState<ReadonlySet<Key>>(new Set());
  const [sources, setSources] = useState(() =>
    MemorySourceKindValues.map((k) =>
      draftOf(
        k,
        status.memorySources.find((m) => m.kind === k),
      ),
    ),
  );
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const typed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setSaved(false);
    };
  const clear = (k: Key) => typed(setCleared)(new Set([...cleared, k]));
  const setSource = (kind: MemorySourceKind, change: Partial<SourceDraft>, touched = true) => {
    setSources((all) => all.map((d) => (d.kind === kind ? { ...d, ...change, changed: d.changed || touched } : d)));
    setSaved(false);
  };

  const submit = async () => {
    // A key cleared and not typed again goes as "" (the server forgets it).
    const value = (k: Key, v: string) => (v.trim() ? v.trim() : cleared.has(k) ? "" : undefined);
    const id = appId.trim();
    const update: SettingsUpdate = {
      deepseekApiKey: value("deepseekApiKey", deepseek),
      agoraAppId: id !== (status.agoraAppId.value ?? "") ? id : cleared.has("agoraAppId") ? "" : undefined,
      agoraAppCertificate: value("agoraAppCertificate", certificate),
      memorySources: !sources.some((d) => d.changed)
        ? undefined
        : sources
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
      const now = await save(update);
      setDeepseek("");
      setCertificate("");
      setAppId(now.agoraAppId.value ?? "");
      setCleared(new Set());
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
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void submit();
      }}
    >
      {part === "deepseek" && (
        <KeyField
          label="DeepSeek API Key"
          help={<TextLink href="https://platform.deepseek.com/api_keys">platform.deepseek.com</TextLink>}
          line={cleared.has("deepseekApiKey") ? "存的时候清掉" : keyLine(status.deepseekApiKey)}
          onClear={status.deepseekApiKey.source === "settings" && !cleared.has("deepseekApiKey") ? () => clear("deepseekApiKey") : undefined}
        >
          <SecretInput aria-label="DeepSeek API Key" placeholder="sk-…（不改就空着）" value={deepseek} onChange={(e) => typed(setDeepseek)(e.target.value)} />
        </KeyField>
      )}
      {part === "agora" && (
        <>
          <KeyField
            label="Agora App ID"
            help={<TextLink href="https://console.agora.io/">console.agora.io</TextLink>}
            line={cleared.has("agoraAppId") ? "存的时候清掉" : status.agoraAppId.source ? `（${from[status.agoraAppId.source]}）` : "还没有"}
            onClear={status.agoraAppId.source === "settings" && !cleared.has("agoraAppId") ? () => clear("agoraAppId") : undefined}
          >
            <TextInput
              aria-label="Agora App ID"
              className="font-mono"
              placeholder="32 位，比如 0123…cdef"
              value={appId}
              onChange={(e) => typed(setAppId)(e.target.value)}
            />
          </KeyField>
          <KeyField
            label="Agora App Certificate"
            help={<span className="text-xs text-muted">和 App ID 在同一个项目里</span>}
            line={cleared.has("agoraAppCertificate") ? "存的时候清掉" : keyLine(status.agoraAppCertificate)}
            onClear={status.agoraAppCertificate.source === "settings" && !cleared.has("agoraAppCertificate") ? () => clear("agoraAppCertificate") : undefined}
          >
            <SecretInput
              aria-label="Agora App Certificate"
              placeholder="不改就空着"
              value={certificate}
              onChange={(e) => typed(setCertificate)(e.target.value)}
            />
          </KeyField>
        </>
      )}
      {part === "memory" && sources.map((d) => <SourceField key={d.kind} draft={d} set={(change, touched) => setSource(d.kind, change, touched)} />)}
      {error && <p className="text-sm text-berry">{error}</p>}
      {saved && <p className="text-sm text-accent">存好了，马上就用上。</p>}
      <div className="flex items-center gap-3 border-t border-line pt-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={status.file}>
          {status.file}
        </span>
        <Button type="submit" tone="primary" disabled={busy}>
          保存
        </Button>
      </div>
    </form>
  );
}

function SourceField({ draft: d, set }: { draft: SourceDraft; set: (change: Partial<SourceDraft>, touched?: boolean) => void }) {
  const label = sourceLabels[d.kind];
  const savedKey = d.saved?.key;
  if (!d.open)
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
        <span className="flex-1 text-sm font-medium">
          记性的来源：{label}（{!d.saved ? "没接" : d.saved.enabled ? "接上了" : "关着"}）
        </span>
        <Button aria-label={`改 ${label}`} onClick={() => set({ open: true }, false)}>
          改
        </Button>
      </div>
    );
  return (
    <div className="rounded-lg border border-line p-3">
      <KeyField
        label={`记性的来源：${label}`}
        help={<Switch label="接上" checked={d.enabled} onChange={(enabled) => set({ enabled })} />}
        line={d.keyCleared ? "key 存的时候清掉" : savedKey?.source ? `key ${keyLine(savedKey)}` : "本机的不用 key"}
        onClear={savedKey?.source === "settings" && !d.keyCleared ? () => set({ keyCleared: true }) : undefined}
      >
        <div className="flex flex-col gap-1.5">
          <TextInput
            aria-label={`${label} 的地址`}
            className="font-mono"
            placeholder={sourceAddress[d.kind]}
            value={d.url}
            onChange={(e) => set({ url: e.target.value })}
          />
          <SecretInput aria-label={`${label} 的 key`} placeholder="key（不用或不改就空着）" value={d.key} onChange={(e) => set({ key: e.target.value })} />
          {d.kind === "everos" && (
            <TextInput
              aria-label={`${label} 的 user_id`}
              placeholder="你在 EverOS 里的 user_id（空着就是 owner）"
              value={d.user}
              onChange={(e) => set({ user: e.target.value })}
            />
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2.5">
          <Switch label="读" hint="开工想起、帮工翻记性时也问它" checked={d.read} onChange={(read) => set({ read })} />
          <Switch label="写" hint="记下的也送一份过去" checked={d.write} onChange={(write) => set({ write })} />
          {d.kind === "nowledge" && (
            <Switch
              label="读全部"
              hint="不只读农场替帮工记的，主人在里面的记忆每个帮工都读得到"
              checked={d.everything}
              onChange={(everything) => set({ everything })}
            />
          )}
        </div>
      </KeyField>
    </div>
  );
}

function KeyField({ label, help, line, onClear, children }: { label: string; help: ReactNode; line: string; onClear?: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-semibold">{label}</span>
        {help}
      </div>
      {children}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-muted">{line}</span>
        {onClear && (
          <TextLink danger onClick={onClear}>
            清掉
          </TextLink>
        )}
      </div>
    </div>
  );
}

/** What the server found of gh (github.status); a refresh asks it to look again. */
export function GitHub() {
  const [refreshed, setRefreshed] = useState<GitHubStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const status = useQuery({ queryKey: ["github"], queryFn: () => api.github.status() });
  const s = refreshed ?? status.data;
  const lines = !s
    ? [status.error ? `问不到服务端：${reasonOf(status.error)}` : "在问服务端……"]
    : [s.installed ? `gh ${s.version}` : "没装 gh", ...(s.loggedIn ? [`已登录 github.com：${s.account}`] : []), ...(s.reason ? [s.reason] : [])];
  return (
    <div className="flex flex-col gap-1.5">
      {lines.map((l) => (
        <p key={l} className="text-sm">
          {l}
        </p>
      ))}
      <p className="text-xs text-muted">能提 PR 的项目在「项目」里看；收获时提 PR 要在配置里打开（github.pr_projects）。</p>
      {error && <p className="text-sm text-berry">{error}</p>}
      <div className="pt-2">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              setRefreshed(await api.github.refresh());
            } catch (e) {
              setError(reasonOf(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          重新检测
        </Button>
      </div>
    </div>
  );
}
