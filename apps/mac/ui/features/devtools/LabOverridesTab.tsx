import { effect, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DebugBundleResult, DebugOverrideConfig } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Field, TextInput } from "../../design/Field";
import { Banner } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { api, reasonOf } from "../../infra/api";
import { DISCONNECT_TOPICS, formatBytes, LATENCY_PRESETS_MS } from "./format";
import { CopyButton, SectionHeader } from "./shared";

export function LabOverridesTab(props: { overrides: DebugOverrideConfig; onUpdated: (next: DebugOverrideConfig) => void }) {
  const rpcDelayMs = signal(props.overrides.rpcDelayMs);
  const sliceDelayMs = signal(props.overrides.sliceDelayMs);
  const targetFilter = signal(props.overrides.targetFilter ?? "");
  const disconnectTopic = signal(props.overrides.disconnectTopic ?? "");
  const saving = signal(false);
  const feedback = signal<{ tone: "ok" | "bad"; text: string } | undefined>(undefined);
  const exporting = signal(false);
  const bundleResult = signal<DebugBundleResult | undefined>(undefined);
  const bundleError = signal<string | undefined>(undefined);

  let lastSyncedKey = "";

  effect(() => {
    const o = props.overrides;
    const key = `${o.rpcDelayMs}|${o.sliceDelayMs}|${o.targetFilter ?? ""}|${o.disconnectTopic ?? ""}`;
    if (key === lastSyncedKey) return;
    lastSyncedKey = key;
    rpcDelayMs.set(o.rpcDelayMs);
    sliceDelayMs.set(o.sliceDelayMs);
    targetFilter.set(o.targetFilter ?? "");
    disconnectTopic.set(o.disconnectTopic ?? "");
  });

  const persist = async (next: DebugOverrideConfig, message: string) => {
    saving.set(true);
    feedback.set(undefined);
    try {
      const saved = await api.debug.override.set(next);
      rpcDelayMs.set(saved.rpcDelayMs);
      sliceDelayMs.set(saved.sliceDelayMs);
      targetFilter.set(saved.targetFilter ?? "");
      disconnectTopic.set(saved.disconnectTopic ?? "");
      props.onUpdated(saved);
      feedback.set({ tone: "ok", text: message });
    } catch (e) {
      feedback.set({ tone: "bad", text: t("web.devtools.status.error", { reason: reasonOf(e) }) });
    } finally {
      saving.set(false);
    }
  };

  const buildConfig = (override?: Partial<DebugOverrideConfig>): DebugOverrideConfig => {
    const filter = (override?.targetFilter ?? targetFilter()).trim();
    const topic = (override?.disconnectTopic ?? disconnectTopic()).trim();
    return {
      rpcDelayMs: override?.rpcDelayMs ?? rpcDelayMs(),
      sliceDelayMs: override?.sliceDelayMs ?? sliceDelayMs(),
      ...(filter ? { targetFilter: filter } : {}),
      ...(topic ? { disconnectTopic: topic } : {}),
    };
  };

  const pickRpcDelay = (ms: number) => {
    rpcDelayMs.set(ms);
    void persist(buildConfig({ rpcDelayMs: ms }), t("web.devtools.lab.applied"));
  };

  const pickSliceDelay = (ms: number) => {
    sliceDelayMs.set(ms);
    void persist(buildConfig({ sliceDelayMs: ms }), t("web.devtools.lab.applied"));
  };

  const applyOverrides = () => {
    void persist(buildConfig(), t("web.devtools.lab.applied"));
  };

  const triggerDisconnect = () => {
    const topic = disconnectTopic().trim() || DISCONNECT_TOPICS[0] || "slice:board";
    disconnectTopic.set(topic);
    void persist(buildConfig({ disconnectTopic: topic }), t("web.devtools.lab.applied"));
  };

  const resetOverrides = () => {
    void persist({ rpcDelayMs: 0, sliceDelayMs: 0 }, t("web.devtools.lab.resetDone"));
  };

  const exportBundle = async () => {
    exporting.set(true);
    bundleError.set(undefined);
    try {
      const res = await api.debug.bundle.export();
      bundleResult.set(res);
    } catch (e) {
      bundleError.set(t("web.devtools.status.error", { reason: reasonOf(e) }));
    } finally {
      exporting.set(false);
    }
  };

  const presetLabel = (ms: number) => (ms === 0 ? "0 ms" : `+${ms} ms`);

  return (
    <Scroll testID="devtools-lab" class="min-h-0 flex-1" contentClass="gap-4 p-3">
      <Banner tone="warn" testID="lab-warning">
        {t("web.devtools.lab.warning")}
      </Banner>

      <View class="gap-3 rounded-md border border-line bg-page p-3">
        <Field label={t("web.devtools.lab.rpcDelayMs")}>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Each of={LATENCY_PRESETS_MS}>
              {(ms) => (
                <Button
                  size="compact"
                  tone={rpcDelayMs() === ms() ? "primary" : "plain"}
                  testID={`lab-rpc-delay-${ms()}`}
                  disabled={saving()}
                  onPress={() => pickRpcDelay(ms())}
                >
                  {presetLabel(ms())}
                </Button>
              )}
            </Each>
            <Text class="pl-1 font-mono text-xs tabular-nums text-muted">{rpcDelayMs()} ms</Text>
          </View>
        </Field>

        <Field label={t("web.devtools.lab.sliceDelayMs")}>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Each of={LATENCY_PRESETS_MS}>
              {(ms) => (
                <Button
                  size="compact"
                  tone={sliceDelayMs() === ms() ? "primary" : "plain"}
                  testID={`lab-slice-delay-${ms()}`}
                  disabled={saving()}
                  onPress={() => pickSliceDelay(ms())}
                >
                  {presetLabel(ms())}
                </Button>
              )}
            </Each>
            <Text class="pl-1 font-mono text-xs tabular-nums text-muted">{sliceDelayMs()} ms</Text>
          </View>
        </Field>

        <Field label={t("web.devtools.lab.targetFilter")}>
          <TextInput
            testID="lab-target-filter"
            accessibilityLabel={t("web.devtools.lab.targetFilter")}
            value={targetFilter()}
            placeholder={t("web.devtools.lab.targetFilterPlaceholder")}
            onInput={(v) => targetFilter.set(v)}
            class="font-mono text-xs"
          />
        </Field>

        <Field label={t("web.devtools.lab.disconnectTopic")}>
          <View class="gap-1.5">
            <View class="flex-row flex-wrap gap-1">
              <Each of={DISCONNECT_TOPICS}>
                {(topic) => (
                  <Button
                    size="compact"
                    tone={disconnectTopic() === topic() ? "primary" : "plain"}
                    testID={`lab-disconnect-preset-${topic().replaceAll(/[^a-zA-Z0-9]+/gu, "-")}`}
                    onPress={() => disconnectTopic.set(topic())}
                  >
                    {topic()}
                  </Button>
                )}
              </Each>
            </View>
            <View class="flex-row items-center gap-2">
              <TextInput
                testID="lab-disconnect-topic"
                accessibilityLabel={t("web.devtools.lab.disconnectTopic")}
                value={disconnectTopic()}
                placeholder={t("web.devtools.lab.disconnectTopicPlaceholder")}
                onInput={(v) => disconnectTopic.set(v)}
                wide={false}
                class="min-w-0 flex-1 font-mono text-xs"
              />
              <Button size="compact" tone="danger" icon="bolt" testID="lab-disconnect-trigger" disabled={saving()} onPress={triggerDisconnect}>
                {t("web.devtools.actions.disconnect")}
              </Button>
            </View>
          </View>
        </Field>

        <View class="flex-row flex-wrap items-center gap-2 pt-1">
          <Button size="compact" tone="primary" icon="check" testID="lab-apply" disabled={saving()} onPress={applyOverrides}>
            {t("web.devtools.actions.apply")}
          </Button>
          <Button size="compact" tone="plain" icon="undo" testID="lab-reset" disabled={saving()} onPress={resetOverrides}>
            {t("web.devtools.actions.reset")}
          </Button>
        </View>

        <If when={feedback()}>
          {(fb) => (
            <Banner tone={fb().tone} size="sm" testID="lab-feedback">
              {fb().text}
            </Banner>
          )}
        </If>
      </View>

      <View class="gap-2.5 rounded-md border border-line bg-page p-3">
        <SectionHeader
          title={t("web.devtools.actions.exportBundle")}
          action={
            <Button size="compact" tone="primary" icon="download" testID="lab-export-bundle" disabled={exporting()} onPress={() => void exportBundle()}>
              {exporting() ? t("web.devtools.actions.exporting") : t("web.devtools.actions.exportBundle")}
            </Button>
          }
        />

        <If when={bundleError()}>
          {(err) => (
            <Banner tone="bad" size="sm">
              {err()}
            </Banner>
          )}
        </If>

        <If when={bundleResult()}>
          {(res) => (
            <View testID="lab-bundle-result" class="gap-2 rounded-sm border border-line bg-side p-2.5">
              <Banner tone="ok" size="sm">
                {t("web.devtools.overview.bundleExported", { path: res().path, redacted: res().redactedCount })}
              </Banner>
              <View class="flex-row flex-wrap items-center justify-between gap-2">
                <View class="flex-row items-center gap-2">
                  <Tag tone="info" label={formatBytes(res().sizeBytes)} />
                  <Text class="font-mono text-2xs text-muted">{res().files.join(", ")}</Text>
                </View>
                <CopyButton text={res().path} testID="lab-bundle-copy" />
              </View>
            </View>
          )}
        </If>
      </View>
    </Scroll>
  );
}
