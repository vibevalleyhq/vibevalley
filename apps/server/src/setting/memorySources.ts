import { t } from "@vibevalley/i18n";
import { MemorySourceKindValues, type MemorySourceUpdate } from "@vibevalley/protocol";
import { isOneOf } from "@vibevalley/protocol/rules";

import { hasSpace, voiceURL } from "./keys.ts";
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
