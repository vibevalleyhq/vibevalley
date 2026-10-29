import { t } from "@vibevalley/i18n";
// Where a saved profile came from: its template and version, and, when the template has a newer one, the update. The
// update is asked twice: it replaces what the owner may have changed in what came from the template.

import { Show } from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import type { Agent } from "@vibevalley/protocol";
import { api, reasonOf } from "@/base/api";
import { ready, useAgentTemplates } from "@/base/query";
import { toast } from "@/ui/toasts";
import { ConfirmButton } from "@/ui/ConfirmButton";

export function FromTemplate(props: { agent: Agent; onUpdated: (a: Agent) => void }) {
  const templates = useAgentTemplates();
  const client = useQueryClient();
  const from = () => props.agent.from;
  const template = () => ready(templates, []).find((t) => t.id === from()?.template);
  const newer = () => {
    const t = template();
    const f = from();
    return t && f && t.version > f.version ? t.version : undefined;
  };
  const update = async () => {
    try {
      const got = await api.agent.template.update({ agent: props.agent.id });
      await client.invalidateQueries({ queryKey: ["agents"] });
      props.onUpdated(got);
      toast(t("web.agent.templates.updated"));
    } catch (e) {
      toast(reasonOf(e), "bad");
    }
  };
  return (
    <Show when={from()}>
      {(f) => (
        <p data-testid="from-template" data-key={f().template} data-version={f().version} class="flex flex-wrap items-center gap-2 text-xs text-muted">
          {t("web.agent.templates.from", { name: template()?.name ?? f().template, version: f().version })}
          <Show when={newer()}>
            {(v) => (
              <ConfirmButton
                label={t("web.agent.templates.update", { version: v() })}
                title={t("web.agent.templates.updateHint")}
                question={t("web.agent.templates.updateHint")}
                tone="primary"
                testid="template-update"
                onConfirm={update}
              />
            )}
          </Show>
        </p>
      )}
    </Show>
  );
}
