// Where a saved profile came from: its template and version, and, when the template has a newer one, the update. The
// update is asked twice: it replaces what the owner may have changed in what came from the template.

import { agentsWording } from "./words";
import { createSignal, Show } from "solid-js";
import { useQueryClient } from "@tanstack/solid-query";
import type { Agent } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { ready, useAgentTemplates } from "../../base/query";
import { toast } from "../../ui/toasts";
import { Button } from "../../ui/Button";

export function FromTemplate(props: { agent: Agent; onUpdated: (a: Agent) => void }) {
  const templates = useAgentTemplates();
  const client = useQueryClient();
  const [sure, setSure] = createSignal(false);
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
      setSure(false);
      props.onUpdated(got);
      toast(agentsWording().templates.updated);
    } catch (e) {
      toast(reasonOf(e), "bad");
    }
  };
  return (
    <Show when={from()}>
      {(f) => (
        <p class="flex flex-wrap items-center gap-2 text-xs text-muted">
          {agentsWording().templates.from(template()?.name ?? f().template, f().version)}
          <Show when={newer()}>
            {(v) => (
              <Show
                when={sure()}
                fallback={
                  <Button title={agentsWording().templates.updateHint} onClick={() => setSure(true)}>
                    {agentsWording().templates.update(v())}
                  </Button>
                }
              >
                <span>{agentsWording().templates.updateHint}</span>
                <Button tone="primary" onClick={() => void update()}>
                  {agentsWording().templates.update(v())}
                </Button>
                <Button onClick={() => setSure(false)}>{agentsWording().never}</Button>
              </Show>
            )}
          </Show>
        </p>
      )}
    </Show>
  );
}
