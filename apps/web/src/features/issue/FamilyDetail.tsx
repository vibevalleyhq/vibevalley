import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { Markdown } from "#/ui/Markdown.tsx";
import { toast } from "#/ui/toasts.ts";

import { ActLines } from "./ActLines";
import { createIssueActs } from "./acts";

export function FamilyDetail(props: { issue: Issue; children: Issue[]; onOpen: (id: string) => void; onClose: (review: boolean) => void }) {
  const acts = createIssueActs(() => props.issue, {
    act: createAct(),
    complete: () => props.onClose(true),
    close: () => props.onClose(false),
    told: (title, description) => toast(t("shared.join.labeled", { label: title, text: description })),
  });
  return (
    <div data-testid="issue-family">
      <div class="flex items-start gap-3 pr-10">
        <h1 class="flex-1 text-xl font-semibold">{props.issue.title}</h1>
        <span class="text-xs text-muted">{t(`shared.stage.${props.issue.stage.state}`)}</span>
      </div>
      <div class="mt-3">
        <ActLines issue={props.issue.id} />
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <For each={props.issue.stage.acts}>
          {(action) => (
            <Button
              data-act={action.act}
              disabled={acts.disabled(action.act)}
              tone={action.act === props.issue.stage.lead ? "primary" : "plain"}
              onClick={() => acts.go(action.act)}
            >
              {acts.label(action.act)}
            </Button>
          )}
        </For>
      </div>
      <Show when={acts.box() || props.issue.stage.acts.some((action) => action.act === "reopen" && action.does === "move" && action.words === "required")}>
        <div class="mt-3">
          <TextArea aria-label={t("shared.act.tell")} value={acts.text()} onInput={(event) => acts.setText(event.currentTarget.value)} />
        </div>
      </Show>
      <Show when={props.issue.description}>
        <div class="mt-4">
          <Markdown text={props.issue.description} />
        </div>
      </Show>
      <h2 class="mt-5 mb-2 text-sm font-semibold">{t("web.issue.family.children")}</h2>
      <div class="divide-y divide-line rounded-lg border border-line">
        <For each={props.children}>
          {(child) => (
            <button
              type="button"
              data-testid="child-issue"
              data-issue={child.id}
              class="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left hover:bg-hover"
              onClick={() => props.onOpen(child.id)}
            >
              <span class="text-xs text-muted">#{child.number}</span>
              <span class="min-w-0 flex-1 text-sm">{child.title}</span>
              <span class="text-xs text-muted">{t(`shared.status.${child.status}`)}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
