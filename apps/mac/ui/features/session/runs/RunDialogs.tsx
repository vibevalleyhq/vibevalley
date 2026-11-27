import { signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { SessionRunCodeResult } from "@vibevalley/protocol";
import { sessionIssueId, sessionProfile, sessionRepo } from "@vibevalley/protocol/rules";

import { Button } from "../../../design/Button";
import { Dialog } from "../../../design/Dialog";
import { Field, Select, TextArea, TextInput } from "../../../design/Field";
import { toast } from "../../../design/toasts";
import { createAct } from "../../../infra/act";
import { useWorkAgents } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { ready, useQueryClient, useRuntimes } from "../../../infra/query";
import { createEffect, createMemo } from "../../../infra/solid";
import type { RunEntry } from "../runsView";
import { allSessionsQuery } from "./presentation";

export function RerunDialog(props: {
  open: boolean;
  onClose: () => void;
  entry: Extract<RunEntry, { kind: "worker" }>;
  lastPrompt?: string | undefined;
  onRerunDone: (newSessionId?: string) => void;
}) {
  const client = useQueryClient();
  const agents = useWorkAgents(true);
  const runtimes = useRuntimes();
  const target = signal("");
  const note = signal("");
  const submitting = createAct((msg) => toast(msg));

  const issueId = () => sessionIssueId(props.entry.session);
  const currentProfile = () => sessionProfile(props.entry.session);
  const currentRuntime = () => props.entry.session.runtime;

  const targetOptions = createMemo(() => {
    const runtimeList = ready(runtimes, []);
    const runtimeLabelById = new Map(runtimeList.map((r) => [r.id, r.preset.label]));
    const opts: { value: string; label: string; group?: string }[] = [];
    if (issueId() !== undefined) {
      for (const a of agents()) {
        const rtLabel = runtimeLabelById.get(a.runtime) ?? a.runtime;
        opts.push({
          value: `agent:${a.id}`,
          label: `${a.name} · ${rtLabel}`,
          group: t("web.session.hub.recovery.groupExperts"),
        });
      }
    }
    for (const r of runtimeList) {
      if (r.installation.status === "available" && r.settings.enabled) {
        opts.push({
          value: `runtime:${r.id}`,
          label: r.preset.label,
          group: t("web.session.hub.recovery.groupEngines"),
        });
      }
    }
    return opts;
  });

  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      note.set("");
      const opts = targetOptions();
      const currentAgentValue = currentProfile() ? `agent:${currentProfile()}` : undefined;
      const currentRuntimeValue = `runtime:${currentRuntime()}`;
      const preferred = opts.find((o) => o.value !== currentAgentValue && o.value !== currentRuntimeValue) ?? opts[0];
      target.set(preferred?.value ?? "");
    },
  );

  const selectedLabel = () => targetOptions().find((o) => o.value === target())?.label ?? target();

  const submit = () => {
    const chosen = target().trim();
    if (!chosen || submitting.busy()) return;
    const rawId = chosen.startsWith("agent:") ? chosen.slice(6) : chosen.startsWith("runtime:") ? chosen.slice(8) : chosen;
    const label = selectedLabel();
    const guidance = note().trim();
    void submitting.run(async () => {
      const id = issueId();
      if (id !== undefined) {
        await api.issue.status.update({
          id,
          status: "todo",
          agent: rawId,
          ...(guidance.length > 0 ? { text: guidance } : {}),
        });
        await client.invalidate(allSessionsQuery());
        toast(t("web.session.hub.recovery.rerunStartedToast", { target: label }));
        props.onClose();
        props.onRerunDone();
        return;
      }
      const session = props.entry.live ?? props.entry.session;
      const cwd = session.cwd ?? "";
      const repo = sessionRepo(session);
      const ws = await api.session.openWorkspace({
        runtime: rawId,
        cwd,
        ...(repo !== undefined ? { repo } : {}),
        ...(session.name ? { title: session.name } : {}),
      });
      const promptText = guidance || props.lastPrompt || t("web.session.hub.recovery.resumePrompt");
      const deliverSessionPrompt = api.session.send;
      await deliverSessionPrompt({ id: ws.id, text: promptText });
      await client.invalidate(allSessionsQuery());
      toast(t("web.session.hub.recovery.rerunStartedToast", { target: label }));
      props.onClose();
      props.onRerunDone(ws.id);
    });
  };

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onClose()}
      title={t("web.session.hub.recovery.rerunTitle")}
      size="sm"
      testid="run-rerun-dialog"
      footer={
        <View class="flex-row items-center justify-end gap-2">
          <Button size="compact" tone="quiet" testID="run-rerun-cancel" onPress={() => props.onClose()}>
            {t("shared.act.close")}
          </Button>
          <Button size="compact" tone="primary" icon="shuffle" testID="run-rerun-confirm" disabled={!target() || submitting.busy()} onPress={submit}>
            {t("web.session.hub.recovery.rerunConfirm")}
          </Button>
        </View>
      }
    >
      <View class="gap-3">
        <Field label={t("web.session.hub.recovery.rerunTarget")}>
          <Select
            searchable
            testid="run-rerun-target"
            label={t("web.session.hub.recovery.rerunTarget")}
            placeholder={t("web.session.hub.recovery.rerunTargetPlaceholder")}
            value={target()}
            onChange={(v) => target.set(v)}
            options={targetOptions()}
          />
        </Field>
        <Field label={t("web.session.hub.recovery.rerunNote")}>
          <TextInput
            testID="run-rerun-note"
            accessibilityLabel={t("web.session.hub.recovery.rerunNote")}
            placeholder={t("web.session.hub.recovery.rerunNotePlaceholder")}
            value={note()}
            onInput={(v) => note.set(v)}
            onSubmit={submit}
          />
        </Field>
      </View>
    </Dialog>
  );
}

export function CodeModeDialog(props: { open: boolean; sessionId: string; onClose: () => void }) {
  const client = useQueryClient();
  const script = signal("");
  const result = signal<SessionRunCodeResult | undefined>(undefined);
  const running = createAct((msg) => toast(msg));

  createEffect(
    () => [props.open, props.sessionId] as const,
    ([open]) => {
      if (!open) return;
      result.set(undefined);
    },
  );

  const submit = () => {
    const body = script().trim();
    if (!body || running.busy()) return;
    void running.run(async () => {
      const res = await api.session.runCode({ id: props.sessionId, script: body });
      result.set(res);
      await client.invalidate(allSessionsQuery());
    });
  };

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onClose()}
      title={t("web.session.hub.codemode.title")}
      size="md"
      testid="run-codemode-dialog"
      footer={
        <View class="flex-row items-center justify-end gap-2">
          <Button size="compact" tone="quiet" testID="run-codemode-cancel" onPress={() => props.onClose()}>
            {t("shared.act.close")}
          </Button>
          <Button size="compact" tone="primary" icon="bolt" testID="run-codemode-submit" disabled={!script().trim() || running.busy()} onPress={submit}>
            {t("web.session.hub.codemode.run")}
          </Button>
        </View>
      }
    >
      <View class="gap-3">
        <Text class="text-xs text-muted">{t("web.session.hub.codemode.description")}</Text>
        <Field label={t("web.session.hub.codemode.scriptLabel")}>
          <TextArea
            testID="run-codemode-script"
            accessibilityLabel={t("web.session.hub.codemode.scriptLabel")}
            placeholder={t("web.session.hub.codemode.scriptPlaceholder")}
            rows={5}
            value={script()}
            onInput={(v) => script.set(v)}
          />
        </Field>
        <If when={result()}>
          {(res) => (
            <View testID="run-codemode-output" class="gap-1 rounded-md border border-line bg-side p-2.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-2xs font-medium text-muted">{t("web.session.hub.codemode.outputLabel")}</Text>
                <Text class="font-mono text-2xs text-faint">
                  {t("web.session.hub.codemode.stats", {
                    steps: res().executedSteps,
                    calls: res().replayedCalls,
                    sleeps: res().replayedSleeps,
                  })}
                </Text>
              </View>
              <Text class="font-mono text-xs text-ink">{res().outputJson}</Text>
            </View>
          )}
        </If>
      </View>
    </Dialog>
  );
}
