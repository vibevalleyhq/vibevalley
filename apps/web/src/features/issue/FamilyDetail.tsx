import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { Markdown } from "#/ui/Markdown.tsx";
import { styleProps } from "#/ui/positioner.ts";
import { toast } from "#/ui/toasts.ts";

import { ActLines } from "./ActLines";
import { createIssueActs } from "./acts";

const familyStyles = stylex.create({
  children: {
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
  },
  child: {
    borderTopStyle: {
      default: null,
      ":not(:last-child)": "solid",
    },
    borderBottomStyle: {
      default: null,
      ":not(:last-child)": "solid",
    },
    borderTopWidth: {
      default: null,
      ":not(:last-child)": "0px",
    },
    borderBottomWidth: {
      default: null,
      ":not(:last-child)": "1px",
    },
    borderColor: {
      default: null,
      ":not(:last-child)": "var(--color-line)",
    },
  },
});

const viewStyles = stylex.create({
  familyDetailDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
    paddingRight: "2.5rem",
  },
  familyDetailH1: {
    flex: "1",
    fontSize: "var(--text-xl)",
    lineHeight: "var(--leading-xl)",
    fontWeight: "var(--font-weight-semibold)",
  },
  familyDetailSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  familyDetailDiv2: {
    marginTop: "0.75rem",
  },
  familyDetailDiv3: {
    marginTop: "0.75rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  familyDetailDiv4: {
    marginTop: "1rem",
  },
  familyDetailH2: {
    marginTop: "1.25rem",
    marginBottom: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  childIssue: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.75rem",
    paddingInline: "0.75rem",
    paddingBlock: "0.75rem",
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
    lineHeight: "var(--leading-sm)",
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
      <div {...styleProps(familyStyles.children)}>
        <For each={props.children}>
          {(child) => (
            <button
              type="button"
              data-testid="child-issue"
              data-issue={child.id}
              {...styleProps([viewStyles.childIssue, familyStyles.child])}
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
