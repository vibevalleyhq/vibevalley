import { t } from "@vibevalley/i18n";
import { MemorySourceKindValues, type MemorySourceUpdate, type SettingsUpdate } from "@vibevalley/protocol";
import { isOneOf } from "@vibevalley/protocol/rules";

import { voiceProblem, voiceURL } from "./voice.ts";

export const keyHint = (key: string) => "…" + key.slice(-4);

export const agoraID = /^[0-9a-fA-F]{32}$/u;

export const hasSpace = (s: string) => /\s/u.test(s);

/** A memory source as settings.json keeps it, with its key: read together, so an address is never paired with another one's key. */
export interface MemorySourceConfig {
  readonly kind: MemorySourceUpdate["kind"];
  readonly url: string;
  readonly enabled?: boolean;
  readonly read?: boolean;
  readonly write?: boolean;
  readonly everything?: boolean;
  readonly user?: string;
  readonly key?: string;
}

export function memorySourcesProblem(sources: readonly MemorySourceUpdate[]): string {
  const seen = new Set<string>();
  for (const m of sources) {
    if (!isOneOf(MemorySourceKindValues, m.kind)) return t("server.setting.memory.unknown", { kind: m.kind });
    if (seen.has(m.kind)) return t("server.setting.memory.twice", { kind: m.kind });
    seen.add(m.kind);
    const url = m.url.trim();
    if (m.enabled && url === "") return t("server.setting.memory.noUrl");
    if (url !== "" && !voiceURL.test(url)) return t("server.setting.memory.url");
    if (m.key !== undefined && hasSpace(m.key.trim())) return t("server.setting.memory.keySpace");
  }
  return "";
}

/** A source given without a key keeps the key saved for its kind. */
export function memorySourcesOver(saved: readonly MemorySourceConfig[], given: readonly MemorySourceUpdate[]): MemorySourceConfig[] {
  return given.map((m) => {
    const key = m.key !== undefined ? m.key.trim() : saved.find((c) => c.kind === m.kind)?.key;
    return {
      kind: m.kind,
      url: m.url.trim(),
      ...(m.enabled ? { enabled: true } : {}),
      ...(m.read ? { read: true } : {}),
      ...(m.write ? { write: true } : {}),
      ...(m.everything === true ? { everything: true } : {}),
      ...(m.user?.trim() ? { user: m.user.trim() } : {}),
      ...(key ? { key } : {}),
    };
  });
}

/** Empty strings clear and are always fine. */
export function settingsProblem(u: SettingsUpdate): string {
  const trimmed = (s: string | undefined) => (s ?? "").trim();
  const deepseek = trimmed(u.deepseekApiKey);
  if (deepseek !== "" && (hasSpace(deepseek) || deepseek.length < 8)) return t("server.setting.deepseekKey");
  const appID = trimmed(u.agoraAppId);
  if (appID !== "" && !agoraID.test(appID)) return t("server.setting.agoraId");
  const certificate = trimmed(u.agoraAppCertificate);
  if (certificate !== "" && !agoraID.test(certificate)) return t("server.setting.agoraCertificate");
  for (const key of [u.asrKey, u.llmKey, u.ttsKey, u.dictationKey, u.mossKey]) if (hasSpace(trimmed(key))) return t("server.setting.voiceKeySpace");
  const d = u.dictation;
  if (d?.via === "own" && d.url.trim() !== "") {
    if (!voiceURL.test(d.url.trim())) return t("server.setting.dictationUrl");
    if (d.model.trim() === "") return t("server.setting.dictationModel");
  }
  const sources = memorySourcesProblem(u.memorySources ?? []);
  if (sources) return sources;
  return u.voice ? voiceProblem(u.voice) : "";
}
