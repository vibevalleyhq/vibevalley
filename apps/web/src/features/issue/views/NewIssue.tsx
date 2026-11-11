import * as stylex from "@stylexjs/stylex";
import { createSignal, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { useWorkAgents } from "#/infra/agents.ts";
import { ready, useRepos } from "#/infra/query.ts";
import { prefsNow } from "#/state/prefs.ts";
import { Button } from "#/ui/Button.tsx";
import { Dialog } from "#/ui/Dialog.tsx";
import { Select, TextArea } from "#/ui/Field.tsx";

const viewStyles = stylex.create({
  newIssueForm: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  newIssueDiv: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  newIssueDiv2: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "0.5rem",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingTop: "0.75rem",
  },
  newIssueSpan: {
    marginRight: "auto",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
});

/** The repo and helper the board is filtered to, or the list group it was opened in. */
export interface NewIssueAt {
  readonly repo?: string;
  readonly agent?: string;
}

export function NewIssue(props: { at: NewIssueAt; onKeep: (words: string, where: NewIssueAt) => void; onClose: () => void }) {
  const [text, setText] = createSignal("");
  // What it was opened with, else what the last issue was given: shown as it will be used (write.ts falls back the same).
  const last = prefsNow();
  const [repo, setRepo] = createSignal(untrack(() => props.at.repo ?? last.repo));
  const [agent, setAgent] = createSignal(untrack(() => props.at.agent ?? (last.pick === "auto" ? "" : last.pick)));
  const agents = useWorkAgents(true);
  const repoList = useRepos();
  const repos = () => ready(repoList, []).map((p) => p.name);
  const keep = () => {
    const words = text().trim();
    if (!words) return;
    props.onKeep(words, { ...(repo() ? { repo: repo() } : {}), ...(agent() ? { agent: agent() } : {}) });
    props.onClose();
  };
  return (
    <Dialog open onClose={() => props.onClose()} title={t("web.issue.new.title")} testid="issue-new-dialog">
      <form
        {...stylex.attrs(viewStyles.newIssueForm)}
        onSubmit={(e) => {
          e.preventDefault();
          keep();
        }}
      >
        <TextArea
          data-testid="issue-new-text"
          aria-label={t("web.issue.new.words")}
          placeholder={t("web.issue.new.placeholder")}
          rows={4}
          value={text()}
          ref={(el) => queueMicrotask(() => el.focus())}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
              e.preventDefault();
              keep();
            }
          }}
        />
        <div {...stylex.attrs(viewStyles.newIssueDiv)}>
          <Select
            quiet
            size="control"
            label={t("web.issue.task.repo")}
            testid="issue-new-repo"
            value={repo()}
            placeholder={t("web.issue.todo.whichRepo")}
            onChange={setRepo}
            options={[...new Set([...repos(), ...(repo() ? [repo()] : [])])].map((p) => ({ value: p, label: p }))}
          />
          <Select
            quiet
            size="control"
            label={t("web.issue.detail.helper")}
            testid="issue-new-helper"
            value={agent()}
            placeholder={t("web.issue.todo.pickForMe")}
            onChange={setAgent}
            options={agents().map((a) => ({ value: a.id, label: a.name }))}
          />
        </div>
        <div {...stylex.attrs(viewStyles.newIssueDiv2)}>
          <span {...stylex.attrs(viewStyles.newIssueSpan)}>{t("web.issue.new.keys")}</span>
          <Button type="button" onClick={() => props.onClose()}>
            {t("web.base.form.never")}
          </Button>
          <Button type="submit" tone="primary" data-testid="issue-new-keep" disabled={!text().trim()}>
            {t("web.issue.new.keep")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
