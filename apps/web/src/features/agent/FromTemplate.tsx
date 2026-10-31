// Where a saved profile came from: its template and version, and, when the template has a newer one, the update. The
// update is asked twice: it replaces what the owner may have changed in what came from the template.

import { useQueryClient } from "@tanstack/solid-query";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Agent } from "@vibevalley/protocol";

import { api } from "@/infra/api";
import { ready, useAgentTemplates } from "@/infra/query";
import { createAct } from "@/ui/act";
import { ConfirmButton } from "@/ui/ConfirmButton";
import { toast } from "@/ui/toasts";

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
  const act = createAct();
  const update = () => {
    const agent = props.agent.id;
    const updated = props.onUpdated;
    return act.run(async () => {
      const got = await api.agent.template.update({ agent });
      await client.invalidateQueries({ queryKey: ["agents"] });
      updated(got);
      toast(t("web.agent.templates.updated"));
    });
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
