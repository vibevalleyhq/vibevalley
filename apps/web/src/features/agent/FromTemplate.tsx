import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Agent } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";
import { useQueryClient, ready, useAgentTemplates } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { toast } from "#/ui/toasts.ts";

const viewStyles = stylex.create({
  fromTemplate: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
});

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
      await client.invalidate({ prefix: ["agents"] });
      updated(got);
      toast(t("web.agent.templates.updated"));
    });
  };
  return (
    <Show when={from()}>
      {(f) => (
        <p data-testid="from-template" data-key={f().template} data-version={f().version} {...stylex.attrs(viewStyles.fromTemplate)}>
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
