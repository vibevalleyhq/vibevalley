import * as stylex from "@stylexjs/stylex";
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

const viewStyles = stylex.create({
  familyDetailDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 3)",
    paddingRight: "calc(var(--spacing) * 10)",
  },
  familyDetailH1: {
    flex: "1",
    fontSize: "var(--text-xl)",
    lineHeight: "var(--text-xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  familyDetailSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  familyDetailDiv2: {
    marginTop: "calc(var(--spacing) * 3)",
  },
  familyDetailDiv3: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  familyDetailDiv4: {
    marginTop: "calc(var(--spacing) * 4)",
  },
  familyDetailH2: {
    marginTop: "calc(var(--spacing) * 5)",
    marginBottom: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  childIssue: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 3)",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  familyDetailSpan2: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
});

export function FamilyDetail(props: { issue: Issue; children: Issue[]; onOpen: (id: string) => void; onClose: (review: boolean) => void }) {
  const acts = createIssueActs(() => props.issue, {
    act: createAct(),
    complete: () => props.onClose(true),
    close: () => props.onClose(false),
    told: (title, description) => toast(t("shared.join.labeled", { label: title, text: description })),
  });
  return (
    <div data-testid="issue-family">
      <div {...stylex.attrs(viewStyles.familyDetailDiv)}>
        <h1 {...stylex.attrs(viewStyles.familyDetailH1)}>{props.issue.title}</h1>
        <span {...stylex.attrs(viewStyles.familyDetailSpan)}>{t(`shared.stage.${props.issue.stage.state}`)}</span>
      </div>
      <div {...stylex.attrs(viewStyles.familyDetailDiv2)}>
        <ActLines issue={props.issue.id} />
      </div>
      <div {...stylex.attrs(viewStyles.familyDetailDiv3)}>
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
        <div {...stylex.attrs(viewStyles.familyDetailDiv2)}>
          <TextArea aria-label={t("shared.act.tell")} value={acts.text()} onInput={(event) => acts.setText(event.currentTarget.value)} />
        </div>
      </Show>
      <Show when={props.issue.description}>
        <div {...stylex.attrs(viewStyles.familyDetailDiv4)}>
          <Markdown text={props.issue.description} />
        </div>
      </Show>
      <h2 {...stylex.attrs(viewStyles.familyDetailH2)}>{t("web.issue.family.children")}</h2>
      <div class="divide-y divide-line rounded-lg border border-line">
        <For each={props.children}>
          {(child) => (
            <button
              type="button"
              data-testid="child-issue"
              data-issue={child.id}
              {...stylex.attrs(viewStyles.childIssue)}
              onClick={() => props.onOpen(child.id)}
            >
              <span {...stylex.attrs(viewStyles.familyDetailSpan)}>#{child.number}</span>
              <span {...stylex.attrs(viewStyles.familyDetailSpan2)}>{child.title}</span>
              <span {...stylex.attrs(viewStyles.familyDetailSpan)}>{t(`shared.status.${child.status}`)}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
